const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const iconsDir = path.join(root, 'build', 'icons');

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });

const iconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="120" y1="80" x2="900" y2="960" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4AC7F4"/>
      <stop offset="0.58" stop-color="#1683DF"/>
      <stop offset="1" stop-color="#0B5BB7"/>
    </linearGradient>
    <linearGradient id="body" x1="400" y1="250" x2="630" y2="790" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.65" stop-color="#E8FAFF"/>
      <stop offset="1" stop-color="#C8F0FF"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(430 360) rotate(48) scale(520)">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="30" stdDeviation="26" flood-color="#06488F" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <circle cx="838" cy="210" r="96" fill="#FFFFFF" opacity="0.08"/>
  <circle cx="166" cy="320" r="46" fill="#FFFFFF" opacity="0.12"/>
  <circle cx="760" cy="755" r="22" fill="#FFFFFF" opacity="0.16"/>
  <circle cx="254" cy="754" r="13" fill="#FFFFFF" opacity="0.22"/>
  <path d="M-30 748C116 676 256 698 382 748C514 800 639 820 776 770C892 728 984 715 1060 735V1054H-30V748Z" fill="#B7EEFF" opacity="0.20"/>
  <path d="M-20 830C144 754 276 788 412 830C560 876 690 900 834 842C938 800 1010 797 1054 809V1054H-20V830Z" fill="#D9F7FF" opacity="0.17"/>
  <g filter="url(#shadow)">
    <ellipse cx="512" cy="823" rx="190" ry="34" fill="#07539D" opacity="0.18"/>
    <path d="M512 206C512 206 314 430 314 593C314 712 401 796 512 796C623 796 710 712 710 593C710 430 512 206 512 206Z" fill="url(#body)"/>
    <path d="M512 206C512 206 314 430 314 593C314 712 401 796 512 796C623 796 710 712 710 593C710 430 512 206 512 206Z" fill="none" stroke="#B5EEFF" stroke-width="12"/>
    <path d="M383 505C412 393 493 319 538 279" fill="none" stroke="#FFFFFF" stroke-width="34" stroke-linecap="round" opacity="0.9"/>
    <path d="M364 598C367 690 420 746 485 767" fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" opacity="0.42"/>
    <path d="M306 631C258 625 224 650 224 683C224 707 244 722 268 717C295 711 306 688 306 660" fill="none" stroke="#AEEBFF" stroke-width="22" stroke-linecap="round"/>
    <path d="M716 631C764 625 798 650 798 683C798 707 778 722 754 717C727 711 716 688 716 660" fill="none" stroke="#AEEBFF" stroke-width="22" stroke-linecap="round"/>
    <ellipse cx="441" cy="581" rx="29" ry="38" fill="#083F70"/>
    <ellipse cx="583" cy="581" rx="29" ry="38" fill="#083F70"/>
    <circle cx="451" cy="568" r="10" fill="#FFFFFF"/>
    <circle cx="593" cy="568" r="10" fill="#FFFFFF"/>
    <ellipse cx="395" cy="650" rx="35" ry="19" fill="#FF9CA8" opacity="0.52"/>
    <ellipse cx="629" cy="650" rx="35" ry="19" fill="#FF9CA8" opacity="0.52"/>
    <path d="M476 655C490 681 534 681 548 655" fill="none" stroke="#083F70" stroke-width="15" stroke-linecap="round"/>
    <path d="M689 303C718 293 740 303 746 324C713 335 689 326 680 310" fill="#66D9F7" opacity="0.74"/>
    <path d="M698 328C719 338 725 357 716 372C691 360 682 344 688 329" fill="#2DB7EA" opacity="0.76"/>
  </g>
  <circle cx="758" cy="394" r="12" fill="#FFFFFF" opacity="0.65"/>
</svg>`;

const traySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="drop" x1="14" y1="8" x2="50" y2="58" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#66D9FA"/>
      <stop offset="1" stop-color="#1479D7"/>
    </linearGradient>
  </defs>
  <ellipse cx="32" cy="57" rx="19" ry="4" fill="#073F79" opacity="0.22"/>
  <path d="M32 5C32 5 12 27 12 40C12 51.6 20.9 59 32 59C43.1 59 52 51.6 52 40C52 27 32 5 32 5Z" fill="url(#drop)" stroke="#0B5FAE" stroke-width="2.5"/>
  <path d="M21 32C23.5 23 29 17.5 33 14.5" fill="none" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" opacity="0.78"/>
  <circle cx="26" cy="39" r="2.8" fill="#073F79"/>
  <circle cx="38" cy="39" r="2.8" fill="#073F79"/>
  <path d="M27 47C30 50 34 50 37 47" fill="none" stroke="#073F79" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;

const templateSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">
  <defs>
    <mask id="cut">
      <rect width="22" height="22" fill="black"/>
      <path d="M11 1.7C11 1.7 3.9 9.5 3.9 14.1C3.9 18.1 7.1 20.8 11 20.8C14.9 20.8 18.1 18.1 18.1 14.1C18.1 9.5 11 1.7 11 1.7Z" fill="white"/>
      <circle cx="8.8" cy="13.2" r="1.05" fill="black"/>
      <circle cx="13.2" cy="13.2" r="1.05" fill="black"/>
      <path d="M9.2 16.2C10 17.1 12 17.1 12.8 16.2" fill="none" stroke="black" stroke-width="1" stroke-linecap="round"/>
    </mask>
  </defs>
  <rect width="22" height="22" fill="black" mask="url(#cut)"/>
</svg>`;

function makeWaveHeader(dataLength, sampleRate = 44100) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function makeChime() {
  const sampleRate = 44100;
  const duration = 1.35;
  const length = Math.floor(sampleRate * duration);
  const samples = new Float32Array(length);
  const notes = [
    { start: 0.03, frequency: 1046.5, gain: 0.72, decay: 0.34 },
    { start: 0.21, frequency: 1318.51, gain: 0.56, decay: 0.44 },
    { start: 0.37, frequency: 1567.98, gain: 0.3, decay: 0.5 }
  ];

  for (const note of notes) {
    const startIndex = Math.floor(note.start * sampleRate);
    for (let i = startIndex; i < length; i += 1) {
      const t = (i - startIndex) / sampleRate;
      const attack = Math.min(1, t / 0.015);
      const envelope = attack * Math.exp(-t / note.decay);
      if (envelope < 0.0001) break;
      const vibrato = 1 + Math.sin(t * 2 * Math.PI * 4.5) * 0.0012;
      const tone =
        Math.sin(2 * Math.PI * note.frequency * t * vibrato) * 0.76 +
        Math.sin(2 * Math.PI * note.frequency * 2 * t * vibrato) * 0.16 +
        Math.sin(2 * Math.PI * note.frequency * 3 * t * vibrato) * 0.055;
      samples[i] += tone * envelope * note.gain;
    }
  }

  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const scale = peak > 0 ? 0.26 / peak : 1;
  const fadeSamples = Math.floor(sampleRate * 0.18);

  const data = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i += 1) {
    let value = samples[i] * scale;
    if (i > length - fadeSamples) {
      value *= (length - i) / fadeSamples;
    }
    const intValue = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    data.writeInt16LE(intValue, i * 2);
  }
  return Buffer.concat([makeWaveHeader(data.length, sampleRate), data]);
}

async function main() {
  fs.writeFileSync(path.join(assetsDir, 'icon.svg'), iconSvg);
  fs.writeFileSync(path.join(assetsDir, 'tray.svg'), traySvg);
  fs.writeFileSync(path.join(assetsDir, 'trayTemplate.svg'), templateSvg);

  const iconBuffer = await sharp(Buffer.from(iconSvg), { density: 256 }).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), iconBuffer);

  const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  await Promise.all(
    iconSizes.map(async (size) => {
      const buffer = await sharp(iconBuffer).resize(size, size).png().toBuffer();
      fs.writeFileSync(path.join(iconsDir, `${size}x${size}.png`), buffer);
    })
  );

  const ico = png2icons.createICO(iconBuffer, png2icons.BICUBIC, 0, true, true);
  if (!ico) throw new Error('Failed to generate ICO');
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);

  const icns = png2icons.createICNS(iconBuffer, png2icons.BICUBIC, 0);
  if (!icns) throw new Error('Failed to generate ICNS');
  fs.writeFileSync(path.join(assetsDir, 'icon.icns'), icns);

  const trayPng = await sharp(Buffer.from(traySvg), { density: 256 }).resize(32, 32).png().toBuffer();
  fs.writeFileSync(path.join(assetsDir, 'tray.png'), trayPng);

  const templatePng = await sharp(Buffer.from(templateSvg), { density: 256 }).resize(22, 22).png().toBuffer();
  fs.writeFileSync(path.join(assetsDir, 'trayTemplate.png'), templatePng);
  const template2x = await sharp(Buffer.from(templateSvg), { density: 256 }).resize(44, 44).png().toBuffer();
  fs.writeFileSync(path.join(assetsDir, 'trayTemplate@2x.png'), template2x);

  fs.writeFileSync(path.join(assetsDir, 'soft-chime.wav'), makeChime());

  console.log('Assets generated in assets/ and build/icons/.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
