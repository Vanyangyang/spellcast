#![cfg_attr(windows, windows_subsystem = "windows")]

use std::io::{self, Write};

fn main() {
    let cfg = spellcast_hook::parse_args(std::env::args());
    let mut stdout = io::stdout();
    let code = spellcast_hook::run(&mut io::stdin(), &mut stdout, &cfg);
    let _ = stdout.flush();
    std::process::exit(code);
}
