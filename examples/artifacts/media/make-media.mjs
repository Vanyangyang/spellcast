import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets'); await mkdir(directory, { recursive: true });
const audio = path.join(directory, 'four-notes.wav'), video = path.join(directory, 'water-route.mp4');
if (await stat(video).catch(() => false)) throw new Error('Example video already exists; preserve it or generate a separate revision.');
const rate = 32000, duration = 8, samples = rate * duration;
const wav = Buffer.alloc(44 + samples * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) { const time = i / rate, phase = time % 2, frequency = [261.63, 329.63, 392, 523.25][Math.floor(time / 2)]; const envelope = Math.min(1, phase / .05, (2 - phase) / .4); wav.writeInt16LE(Math.round(32767 * .16 * Math.max(0, envelope) * (Math.sin(time * frequency * Math.PI * 2) + .15 * Math.sin(time * frequency * Math.PI * 4))), 44 + i * 2); }
if (!await stat(audio).catch(() => false)) await writeFile(audio, wav);
const background = 'color=c=0xF0F5F5:s=960x540:r=24:d=8';
const particle = 'color=c=0x2D8B7D:s=22x22:r=24:d=8';
const fontPath = path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', 'segoeui.ttf');
await stat(fontPath);
const font = "fontfile='" + fontPath.replaceAll('\\', '/').replace(':', '\\:') + "':";
const filter = '[0:v]drawbox=x=90:y=247:w=330:h=12:color=0xCFDEDC:t=fill,drawbox=x=467:y=160:w=12:h=220:color=0xCFDEDC:t=fill,drawbox=x=475:y=375:w=340:h=12:color=0xCFDEDC:t=fill,' +
  'drawbox=x=70:y=185:w=140:h=135:color=0x9FC7BD:t=fill,drawbox=x=412:y=185:w=125:h=135:color=0xE0BD78:t=fill,drawbox=x=740:y=316:w=140:h=130:color=0x9FC7BD:t=fill,' +
  "drawtext=text='WATER ROUTE':fontcolor=0x214B46:fontsize=38:x=65:y=48,drawtext=text='Collect':fontcolor=0x214B46:fontsize=24:x=95:y=340,drawtext=text='Filter':fontcolor=0x214B46:fontsize=24:x=442:y=340,drawtext=text='Store':fontcolor=0x214B46:fontsize=24:x=780:y=465[base];" +
  "[base][1:v]overlay=x='210+mod(t*85,190)':y=242:shortest=1[a];[a][2:v]overlay=x=462:y='320+mod(t*48,50)':shortest=1[b];[b][3:v]overlay=x='510+mod(t*85,220)':y=370:shortest=1[outv]";
const args = ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', background];
for (let i = 0; i < 3; i++) args.push('-f', 'lavfi', '-i', particle);
args.push('-i', audio, '-filter_complex', filter.replaceAll('drawtext=', 'drawtext=' + font), '-map', '[outv]', '-map', '4:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-t', '8', '-movflags', '+faststart', video);
const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'FFmpeg failed');
console.log(JSON.stringify({ audio, video, seconds: duration, sample_rate: rate, frames: 192 }));
