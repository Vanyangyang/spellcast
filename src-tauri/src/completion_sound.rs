//! One short tone per client, synthesised in memory: no sound file ships, nothing is downloaded, and no task text is
//! involved. Each client differs in register, contour and timbre, so a finished task can be told apart with the screen
//! out of sight: Codex is a high rising glass chime, Claude a warm falling wooden knock, Grok three short console blips.
use crate::completion_hook::{CLIENT_CLAUDE, CLIENT_GROK};

pub const SAMPLE_RATE: u32 = 44_100;
/// Every tone is levelled to the same average loudness (RMS, as a fraction of full scale), so a dense blip does not
/// startle more than a soft chime; the ceiling only guards against a spiky one.
pub const LEVEL: f32 = 0.05;
pub const CEILING: f32 = 0.33;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sound { Codex, Claude, Grok }

impl Sound {
    /// Any client without a tone of its own sounds like Codex, the same default the inbox uses.
    pub fn of(client: &str) -> Self {
        match client { CLIENT_CLAUDE => Sound::Claude, CLIENT_GROK => Sound::Grok, _ => Sound::Codex }
    }

    pub fn key(self) -> &'static str {
        match self { Sound::Codex => "codex", Sound::Claude => "claude", Sound::Grok => "grok" }
    }
}

/// One struck note. Each partial is (frequency ratio, amplitude, decay per second) and fades exponentially.
struct Note { start: f32, hz: f32, length: f32, partials: &'static [(f32, f32, f32)] }

// Bell partials sit off the harmonic series, which is what makes it sound like glass.
const GLASS: &[(f32, f32, f32)] = &[(1.0, 1.0, 6.0), (2.76, 0.30, 9.0), (5.4, 0.10, 13.0)];
// A marimba bar rings at 1x and 4x its pitch and dies quickly: soft, dry, warm.
const WOOD: &[(f32, f32, f32)] = &[(1.0, 1.0, 10.0), (4.0, 0.35, 22.0), (9.2, 0.06, 36.0)];
// Odd harmonics only, cut short: a hollow, square-ish console blip.
const BLIP: &[(f32, f32, f32)] = &[(1.0, 1.0, 16.0), (3.0, 0.33, 20.0), (5.0, 0.20, 24.0)];

fn notes(sound: Sound) -> &'static [Note] {
    match sound {
        // A5 then E6, a fifth up.
        Sound::Codex => &[
            Note { start: 0.00, hz: 880.00, length: 0.75, partials: GLASS },
            Note { start: 0.15, hz: 1318.51, length: 0.75, partials: GLASS },
        ],
        // G5 then D5, a fourth down: it settles instead of asking.
        Sound::Claude => &[
            Note { start: 0.00, hz: 783.99, length: 0.45, partials: WOOD },
            Note { start: 0.17, hz: 587.33, length: 0.45, partials: WOOD },
        ],
        // G4, G4, C5, quickly.
        Sound::Grok => &[
            Note { start: 0.00, hz: 392.00, length: 0.12, partials: BLIP },
            Note { start: 0.10, hz: 392.00, length: 0.12, partials: BLIP },
            Note { start: 0.20, hz: 523.25, length: 0.14, partials: BLIP },
        ],
    }
}

/// Mono samples at `SAMPLE_RATE`, levelled to `LEVEL` and starting and ending at silence.
pub fn samples(sound: Sound) -> Vec<i16> {
    let rate = SAMPLE_RATE as f32;
    let notes = notes(sound);
    let total = notes.iter().map(|n| n.start + n.length).fold(0.0, f32::max);
    let mut mix = vec![0.0f32; (total * rate).ceil() as usize + 1];
    for note in notes {
        let first = (note.start * rate).round() as usize;
        for i in 0..(note.length * rate) as usize {
            let t = i as f32 / rate;
            // A few milliseconds of attack keep the strike from clicking.
            let attack = (t / 0.004).min(1.0);
            let wave: f32 = note.partials.iter()
                .map(|&(ratio, amp, decay)| amp * (-decay * t).exp() * (std::f32::consts::TAU * note.hz * ratio * t).sin())
                .sum();
            if let Some(slot) = mix.get_mut(first + i) { *slot += attack * wave; }
        }
    }
    // Whatever is still ringing when a note's length ends is faded out rather than cut.
    let fade = (0.03 * rate) as usize;
    for (i, slot) in mix.iter_mut().rev().take(fade).enumerate() { *slot *= i as f32 / fade as f32; }
    let loudest = mix.iter().fold(0.0f32, |a, s| a.max(s.abs())).max(f32::EPSILON);
    let rms = (mix.iter().map(|s| s * s).sum::<f32>() / mix.len() as f32).sqrt().max(f32::EPSILON);
    let gain = (LEVEL / rms).min(CEILING / loudest) * f32::from(i16::MAX);
    mix.iter().map(|s| (s * gain).round() as i16).collect()
}

/// A complete 16-bit mono PCM WAV file.
pub fn wav(sound: Sound) -> Vec<u8> {
    let pcm = samples(sound);
    let data = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for sample in pcm { out.extend_from_slice(&sample.to_le_bytes()); }
    out
}

/// Play one tone on the default audio device and return when it has finished. Playbacks queue behind each other,
/// because `PlaySound` cuts off whatever is already sounding.
#[cfg(windows)]
pub fn play(sound: Sound) -> Result<(), String> {
    use std::{ffi::c_void, sync::Mutex};
    #[link(name = "winmm")]
    extern "system" {
        fn PlaySoundW(sound: *const u16, module: *mut c_void, flags: u32) -> i32;
    }
    const SND_SYNC: u32 = 0x0000;
    const SND_NODEFAULT: u32 = 0x0002;
    const SND_MEMORY: u32 = 0x0004;
    static PLAYING: Mutex<()> = Mutex::new(());
    let wav = wav(sound);
    let _turn = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // SND_SYNC returns after the tone has played, so the buffer outlives the call; SND_NODEFAULT keeps a failure silent.
    let played = unsafe { PlaySoundW(wav.as_ptr().cast(), std::ptr::null_mut(), SND_MEMORY | SND_NODEFAULT | SND_SYNC) };
    if played == 0 { Err("no audio device accepted the sound".into()) } else { Ok(()) }
}

#[cfg(not(windows))]
pub fn play(_sound: Sound) -> Result<(), String> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Sound; 3] = [Sound::Codex, Sound::Claude, Sound::Grok];

    /// Signal energy at one frequency (Goertzel), enough to tell which pitch a window is dominated by.
    fn energy(window: &[i16], hz: f32) -> f32 {
        let w = std::f32::consts::TAU * hz / SAMPLE_RATE as f32;
        let (mut a, mut b) = (0.0f32, 0.0f32);
        for &s in window { let next = f32::from(s) + 2.0 * w.cos() * a - b; b = a; a = next; }
        a * a + b * b - 2.0 * w.cos() * a * b
    }

    #[test]
    fn clients_map_to_their_own_tone_and_unknown_ones_to_codex() {
        assert_eq!(Sound::of("codex"), Sound::Codex);
        assert_eq!(Sound::of("claude"), Sound::Claude);
        assert_eq!(Sound::of("grok"), Sound::Grok);
        assert_eq!(Sound::of("something-new"), Sound::Codex);
        let keys: std::collections::HashSet<_> = ALL.iter().map(|s| s.key()).collect();
        assert_eq!(keys.len(), 3);
    }

    #[test]
    fn every_tone_is_a_quiet_short_clean_wav() {
        for sound in ALL {
            let pcm = samples(sound);
            let seconds = pcm.len() as f32 / SAMPLE_RATE as f32;
            assert!((0.25..1.2).contains(&seconds), "{sound:?} lasts {seconds}s");
            let loudest = pcm.iter().map(|s| i32::from(*s).abs()).max().unwrap();
            assert!(loudest as f32 <= CEILING * f32::from(i16::MAX) + 1.0, "{sound:?} peaks at {loudest}");
            let rms = (pcm.iter().map(|s| f32::from(*s).powi(2)).sum::<f32>() / pcm.len() as f32).sqrt() / f32::from(i16::MAX);
            assert!((rms - LEVEL).abs() < LEVEL * 0.02, "{sound:?} averages {rms}, wanted {LEVEL}");
            assert!(pcm[0].abs() < 300 && pcm[pcm.len() - 1] == 0, "{sound:?} must start and end at silence");
            let bytes = wav(sound);
            assert_eq!(&bytes[0..4], b"RIFF");
            assert_eq!(&bytes[8..16], b"WAVEfmt ");
            assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize, bytes.len() - 8);
            assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), SAMPLE_RATE);
            assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize, pcm.len() * 2);
        }
    }

    #[test]
    fn each_client_opens_on_its_own_pitch_and_sounds_different() {
        let first_notes = [(Sound::Codex, 880.0), (Sound::Claude, 783.99), (Sound::Grok, 392.0)];
        for (sound, own) in first_notes {
            let pcm = samples(sound);
            let window = &pcm[..(0.08 * SAMPLE_RATE as f32) as usize];
            let strongest = first_notes.iter()
                .max_by(|a, b| energy(window, a.1).total_cmp(&energy(window, b.1))).unwrap();
            assert_eq!(strongest.0, sound, "{sound:?} should open on {own} Hz");
        }
        let all: Vec<_> = ALL.iter().map(|s| wav(*s)).collect();
        assert!(all[0] != all[1] && all[1] != all[2] && all[0] != all[2]);
        // Register: Codex is the longest and rings; Grok is the shortest.
        let lengths: Vec<_> = ALL.iter().map(|s| samples(*s).len()).collect();
        assert!(lengths[0] > lengths[1] && lengths[1] > lengths[2], "{lengths:?}");
    }

    /// Plays the three tones through the app's own `play`, Codex, Claude, Grok, two seconds apart. Ignores quiet hours:
    /// whoever runs it asked to listen.
    #[cfg(windows)]
    #[test]
    #[ignore = "plays the three tones through the Windows default audio device"]
    fn audition_tones() {
        for sound in ALL {
            println!("playing {}", sound.key());
            play(sound).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }

    /// Writes the three tones as WAV files so they can be listened to without the app: set SPELLCAST_SOUND_PREVIEW_DIR.
    #[test]
    #[ignore = "writes preview files to SPELLCAST_SOUND_PREVIEW_DIR"]
    fn write_tone_previews() {
        let dir = std::path::PathBuf::from(std::env::var_os("SPELLCAST_SOUND_PREVIEW_DIR").expect("SPELLCAST_SOUND_PREVIEW_DIR"));
        std::fs::create_dir_all(&dir).unwrap();
        for sound in ALL { std::fs::write(dir.join(format!("{}.wav", sound.key())), wav(sound)).unwrap(); }
    }
}
