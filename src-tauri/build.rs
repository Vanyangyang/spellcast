fn main() {
    tauri_build::build();
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=examples/webview_teardown.manifest");
        println!("cargo:rerun-if-changed=examples/webview_teardown.rc");
        // Examples only (not the production spellcast.exe). Cargo has no
        // per-example link-arg, so this applies to all examples.
        embed_resource::compile_for_examples("examples/webview_teardown.rc", embed_resource::NONE)
            .manifest_required()
            .expect("webview_teardown Common Controls v6 manifest");
    }
}
