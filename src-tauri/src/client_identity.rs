//! Windows kernel peer proof. No claimed PID, path, SID or hash is accepted from
//! the wire. Only executable images are read; no project files or credentials.
#![cfg(windows)]
use sha2::{Digest, Sha256};
use spellcast_bridge::client_access::{ClientError, ClientIdentity, OsClient};
use std::{
    fs::File,
    io::Read,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{LocalFree, FILETIME, HANDLE, WAIT_TIMEOUT},
    Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SE_FILE_OBJECT,
    },
    Security::{
        GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
    System::{
        Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
        Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
            QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    },
};

#[derive(Debug, Clone, Copy)]
pub enum NativeError {
    IdentityUnknown,
    IdentityChanged,
    StorageUnprotected,
    PipeUnavailable,
    InvalidRequest,
}
impl NativeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::IdentityUnknown => "identity_unknown",
            Self::IdentityChanged => "identity_changed",
            Self::StorageUnprotected => "storage_unprotected",
            Self::PipeUnavailable => "pipe_unavailable",
            Self::InvalidRequest => "invalid_request",
        }
    }
}

pub struct ProcessProof {
    process: OwnedHandle,
    _image: File,
    pub identity: ClientIdentity,
    pub pid: u32,
    pub created_at: u64,
}
fn owned(raw: HANDLE) -> Result<OwnedHandle, NativeError> {
    if raw.is_null() || raw == (-1isize as HANDLE) {
        return Err(NativeError::IdentityUnknown);
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
unsafe fn sid_string(sid: *mut std::ffi::c_void) -> Result<String, NativeError> {
    if sid.is_null() {
        return Err(NativeError::IdentityUnknown);
    }
    let mut raw = ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut raw) == 0 {
        return Err(NativeError::IdentityUnknown);
    }
    let mut length = 0;
    while length < 184 && *raw.add(length) != 0 {
        length += 1;
    }
    let result = if length == 184 {
        Err(NativeError::IdentityUnknown)
    } else {
        String::from_utf16(std::slice::from_raw_parts(raw, length))
            .map_err(|_| NativeError::IdentityUnknown)
    };
    LocalFree(raw.cast());
    result
}
fn process_sid(process: HANDLE) -> Result<String, NativeError> {
    let mut raw = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return Err(NativeError::IdentityUnknown);
    }
    let token = owned(raw)?;
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        );
    }
    if size == 0 || size > 65536 {
        return Err(NativeError::IdentityUnknown);
    }
    // u64 storage is correctly aligned for TOKEN_USER and its embedded SID.
    let mut buffer = vec![0u64; (size as usize + 7) / 8];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(NativeError::IdentityUnknown);
    }
    unsafe { sid_string((*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid) }
}
pub fn current_sid() -> Result<String, NativeError> {
    let process =
        owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, std::process::id()) })?;
    process_sid(process.as_raw_handle())
}
fn creation_time(process: HANDLE) -> Result<u64, NativeError> {
    // An exited process may deliberately return STILL_ACTIVE (259). The kernel
    // process signal is authoritative; exit code alone is not liveness proof.
    if unsafe { WaitForSingleObject(process, 0) } != WAIT_TIMEOUT {
        return Err(NativeError::IdentityUnknown);
    }
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit = 0;
    if unsafe { GetExitCodeProcess(process, &mut exit) } == 0 || exit != 259 {
        return Err(NativeError::IdentityUnknown);
    }
    if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(NativeError::IdentityUnknown);
    }
    let value = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    if value == 0 {
        Err(NativeError::IdentityUnknown)
    } else {
        Ok(value)
    }
}
fn process_path(process: HANDLE) -> Result<String, NativeError> {
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) } == 0
        || size == 0
        || size as usize >= buffer.len()
    {
        return Err(NativeError::IdentityUnknown);
    }
    String::from_utf16(&buffer[..size as usize]).map_err(|_| NativeError::IdentityUnknown)
}
pub fn query_process(pid: u32) -> Result<ProcessProof, NativeError> {
    let process = owned(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    })?;
    let created_at = creation_time(process.as_raw_handle())?;
    let path = process_path(process.as_raw_handle())?;
    if !Path::new(&path).is_absolute() || path.starts_with("\\\\") {
        return Err(NativeError::IdentityUnknown);
    }
    // No write/delete sharing: the image cannot be replaced between hashing and commit.
    let mut image = File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|_| NativeError::IdentityUnknown)?;
    let metadata = image.metadata().map_err(|_| NativeError::IdentityUnknown)?;
    if !metadata.is_file()
        || metadata.len() > 512 * 1024 * 1024
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(NativeError::IdentityUnknown);
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(image.as_raw_handle(), &mut info) } == 0 {
        return Err(NativeError::IdentityUnknown);
    }
    let mut buffer = vec![0u16; 32768];
    let size = unsafe {
        GetFinalPathNameByHandleW(
            image.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if size == 0 || size as usize >= buffer.len() {
        return Err(NativeError::IdentityUnknown);
    }
    let canonical =
        String::from_utf16(&buffer[..size as usize]).map_err(|_| NativeError::IdentityUnknown)?;
    let canonical = canonical
        .strip_prefix("\\\\?\\")
        .unwrap_or(&canonical)
        .to_string();
    if !canonical.eq_ignore_ascii_case(&path) {
        return Err(NativeError::IdentityChanged);
    }
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = image
            .read(&mut bytes)
            .map_err(|_| NativeError::IdentityUnknown)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    let identity = ClientIdentity {
        path: canonical,
        sha256: format!("{:x}", hash.finalize()),
        sid: process_sid(process.as_raw_handle())?,
        file_id: format!(
            "{:08x}-{:08x}-{:08x}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ),
    };
    let proof = ProcessProof {
        process,
        _image: image,
        identity,
        pid,
        created_at,
    };
    proof.assert_live()?;
    Ok(proof)
}
impl ProcessProof {
    pub fn assert_live(&self) -> Result<(), NativeError> {
        if creation_time(self.process.as_raw_handle())? != self.created_at
            || !process_path(self.process.as_raw_handle())?
                .eq_ignore_ascii_case(&self.identity.path)
        {
            return Err(NativeError::IdentityChanged);
        }
        Ok(())
    }
    pub fn client(&self) -> Result<OsClient, NativeError> {
        self.assert_live()?;
        if self.identity.sid != current_sid()? {
            return Err(NativeError::IdentityUnknown);
        }
        OsClient::from_verified_os(self.identity.clone(), self.pid, self.created_at)
            .map_err(|_| NativeError::IdentityUnknown)
    }
}
pub fn query_pipe_peer(pipe: HANDLE, server_peer: bool) -> Result<ProcessProof, NativeError> {
    let mut pid = 0;
    let success = unsafe {
        if server_peer {
            GetNamedPipeServerProcessId(pipe, &mut pid)
        } else {
            GetNamedPipeClientProcessId(pipe, &mut pid)
        }
    };
    if success == 0 || pid == 0 {
        return Err(NativeError::IdentityUnknown);
    }
    query_process(pid)
}
/// Reference verifier for the CCGUI native adapter. `expected` MUST come from
/// its native user-approved installation identity, never the pipe's JSON reply.
pub fn verify_server(pipe: HANDLE, expected: &ClientIdentity) -> Result<ProcessProof, NativeError> {
    let proof = query_pipe_peer(pipe, true)?;
    if proof.identity != *expected
        || proof.identity.sid != current_sid()?
        || !Path::new(&proof.identity.path)
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("spellcast.exe"))
    {
        return Err(NativeError::IdentityChanged);
    }
    Ok(proof)
}

pub struct Descriptor(*mut std::ffi::c_void);
impl Descriptor {
    pub fn for_pipe(sid: &str) -> Result<Self, NativeError> {
        let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(NativeError::PipeUnavailable);
        }
        Ok(Self(descriptor))
    }
    pub fn raw(&self) -> *mut std::ffi::c_void {
        self.0
    }
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

/// Do not change a shared/custom parent directory's ACL. Delegation is disabled
/// unless its existing DACL already restricts access to this user/admin/System.
pub fn secure_storage(database: &Path) -> Result<(), NativeError> {
    let parent = database.parent().ok_or(NativeError::StorageUnprotected)?;
    crate::project_api_key::require_plain(parent).map_err(|_| NativeError::StorageUnprotected)?;
    if parent
        .metadata()
        .map_err(|_| NativeError::StorageUnprotected)?
        .file_attributes()
        & FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return Err(NativeError::StorageUnprotected);
    }
    let target = wide(parent.to_str().ok_or(NativeError::StorageUnprotected)?);
    let mut owner = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            target.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return Err(NativeError::StorageUnprotected);
    }
    let descriptor = Descriptor(descriptor);
    let sid = current_sid()?;
    if unsafe { sid_string(owner) }? != sid || acl.is_null() {
        return Err(NativeError::StorageUnprotected);
    }
    for index in 0..unsafe { (*acl).AceCount } {
        let mut raw = ptr::null_mut();
        if unsafe { GetAce(acl, index as u32, &mut raw) } == 0 {
            return Err(NativeError::StorageUnprotected);
        }
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if header.AceType == 1 {
            continue;
        } // deny ACE
        if header.AceType != 0 {
            return Err(NativeError::StorageUnprotected);
        }
        let allowed = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
        let ace_sid = unsafe { sid_string((&allowed.SidStart as *const u32).cast_mut().cast()) }?;
        if ![
            sid.as_str(),
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-3-4",
            "S-1-3-0",
        ]
        .contains(&ace_sid.as_str())
        {
            return Err(NativeError::StorageUnprotected);
        }
    }
    drop(descriptor);
    // Only these explicit application-owned files; never recursive ACL edits.
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let mut path = database.as_os_str().to_os_string();
        path.push(suffix);
        let path = std::path::PathBuf::from(path);
        if path.exists() {
            crate::project_api_key::require_plain(&path)
                .map_err(|_| NativeError::StorageUnprotected)?;
            let file = File::options()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
                .map_err(|_| NativeError::StorageUnprotected)?;
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
                || info.nNumberOfLinks != 1
                || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(NativeError::StorageUnprotected);
            }
            // Owner-only ACL means this OS user, not whichever different owner
            // an imported/copied file may have retained. Do not take ownership.
            let name = wide(path.to_str().ok_or(NativeError::StorageUnprotected)?);
            let mut file_owner = ptr::null_mut();
            let mut file_descriptor = ptr::null_mut();
            if unsafe {
                GetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION,
                    &mut file_owner,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut file_descriptor,
                )
            } != 0
            {
                return Err(NativeError::StorageUnprotected);
            }
            let _file_descriptor = Descriptor(file_descriptor);
            if unsafe { sid_string(file_owner) }? != sid {
                return Err(NativeError::StorageUnprotected);
            }
            crate::project_api_key::protect(&path, false)
                .map_err(|_| NativeError::StorageUnprotected)?;
        }
    }
    Ok(())
}
impl From<NativeError> for ClientError {
    fn from(e: NativeError) -> Self {
        match e {
            NativeError::IdentityChanged => Self::IdentityChanged,
            _ => Self::IdentityUnknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_exit259_child_fixture() {
        if std::env::var_os("SPELLCAST_NATIVE_EXIT259_TEST_CHILD").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            std::process::exit(259);
        }
    }
    #[test]
    fn native_terminated_process_with_exit259_is_not_live() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "client_identity::tests::native_exit259_child_fixture",
            ])
            .env("SPELLCAST_NATIVE_EXIT259_TEST_CHILD", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let process = owned(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                child.id(),
            )
        })
        .unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(259));
        let mut exit = 0;
        assert_ne!(
            unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit) },
            0
        );
        assert_eq!(exit, 259);
        assert!(creation_time(process.as_raw_handle()).is_err());
        assert!(query_process(child.id()).is_err());
    }
    #[test]
    fn native_self_process_image_and_birth_are_checked_without_application_authority() {
        let proof = query_process(std::process::id()).unwrap();
        assert_eq!(proof.identity.sid, current_sid().unwrap());
        assert_eq!(proof.identity.sha256.len(), 64);
        assert!(!proof.identity.file_id.is_empty());
        proof.assert_live().unwrap();
        assert!(proof.client().is_err());
        assert!(query_process(0).is_err());
    }
    #[test]
    fn native_private_storage_check_is_confined_to_temporary_fixture() {
        let root = std::env::temp_dir().join(format!(
            "spellcast-client-acl-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        crate::project_api_key::protect(&root, true).unwrap();
        let database = root.join("synthetic.sqlite3");
        std::fs::write(&database, b"synthetic no user data").unwrap();
        secure_storage(&database).unwrap();
        assert_eq!(std::fs::read(&database).unwrap(), b"synthetic no user data");
        let mut descriptor = ptr::null_mut();
        let sddl = wide("D:P(A;OICI;FA;;;WD)");
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            },
            0
        );
        let descriptor = Descriptor(descriptor);
        use windows_sys::Win32::Security::{SetFileSecurityW, PROTECTED_DACL_SECURITY_INFORMATION};
        let path = wide(root.to_str().unwrap());
        assert_ne!(
            unsafe {
                SetFileSecurityW(
                    path.as_ptr(),
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    descriptor.raw(),
                )
            },
            0
        );
        assert!(matches!(
            secure_storage(&database),
            Err(NativeError::StorageUnprotected)
        ));
        crate::project_api_key::protect(&root, true).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_storage_hard_links_are_rejected_without_editing_external_acl() {
        let root = std::env::temp_dir().join(format!(
            "spellcast-client-hardlink-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        crate::project_api_key::protect(&root, true).unwrap();
        let db = root.join("fixture.sqlite3");
        std::fs::write(&db, b"synthetic").unwrap();
        std::fs::hard_link(&db, root.join("same-file.sqlite3")).unwrap();
        assert!(matches!(
            secure_storage(&db),
            Err(NativeError::StorageUnprotected)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
