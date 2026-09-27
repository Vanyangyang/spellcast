//! Private local automation credential. Never expose it through HTTP or window IPC.
use std::{fs, io::Write, path::Path};

pub(crate) fn load_or_create(database: &Path) -> Result<String, String> {
    let directory=database.parent().ok_or("项目数据库没有父目录")?.join("credentials");
    fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    require_plain(&directory)?;
    protect(&directory,true)?;
    let path=directory.join("project-api.key");
    if !path.try_exists().map_err(|e|e.to_string())? {
        let key=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
        let mut options=fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => { file.write_all(key.as_bytes()).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?; }
            Err(error) if error.kind()==std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    require_plain(&path)?;
    protect(&path,false)?;
    let value=fs::read_to_string(&path).map_err(|e|e.to_string())?;
    if value.len()!=64 || !value.bytes().all(|b|b.is_ascii_hexdigit()) {
        return Err("本机项目凭据格式无效；未自动覆盖或降低鉴权要求。".into());
    }
    Ok(value)
}

fn require_plain(path: &Path) -> Result<(),String> {
    let metadata=fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if metadata.file_type().is_symlink() { return Err("项目凭据路径不能是符号链接。".into()); }
    Ok(())
}

#[cfg(unix)]
fn protect(path:&Path,directory:bool)->Result<(),String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path,fs::Permissions::from_mode(if directory {0o700}else{0o600})).map_err(|e|e.to_string())
}

#[cfg(windows)]
fn protect(path:&Path,directory:bool)->Result<(),String> {
    use std::{os::windows::ffi::OsStrExt,ptr};
    use windows_sys::Win32::{Foundation::LocalFree,Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetFileSecurityW,DACL_SECURITY_INFORMATION,PROTECTED_DACL_SECURITY_INFORMATION,
    }};
    // Protected DACL; only this object's owner gets access. Administrators can still
    // exercise OS ownership privileges, as with other local user credentials.
    let sddl:Vec<u16>=(if directory {"D:P(A;OICI;FA;;;OW)"}else{"D:P(A;;FA;;;OW)"}).encode_utf16().chain(Some(0)).collect();
    let target:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut descriptor=ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(),1,&mut descriptor,ptr::null_mut())==0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let success=SetFileSecurityW(target.as_ptr(),DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,descriptor)!=0;
        let error=if success {None}else{Some(std::io::Error::last_os_error().to_string())};
        LocalFree(descriptor);
        error.map_or(Ok(()),Err)
    }
}

#[cfg(not(any(unix,windows)))]
fn protect(_: &Path,_:bool)->Result<(),String> { Err("此系统暂不支持保护本机项目凭据。".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_credential_persists_and_malformed_content_fails_closed() {
        let root=std::env::temp_dir().join(format!("spellcast-project-key-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let db=root.join("fixture.sqlite3");
        let first=load_or_create(&db).unwrap();
        assert_eq!(first.len(),64);
        assert_eq!(first,load_or_create(&db).unwrap());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(root.join("credentials/project-api.key")).unwrap().permissions().mode() & 0o777,0o600);
        }
        fs::write(root.join("credentials/project-api.key"),"invalid").unwrap();
        assert!(load_or_create(&db).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
