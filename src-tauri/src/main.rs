#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    if spellcast_lib::handle_completion_command() { return; }
    spellcast_lib::run()
}
