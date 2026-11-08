'use strict';
(() => {
  // =====================================================================
  //  LAST LINE — difendi le mura. Gioco a ondate a scorrimento orizzontale.
  //  Il cavaliere si muove solo a destra/sinistra, attacca, para e usa la Furia.
  // =====================================================================

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ---------- Scala: altezza logica fissa, larghezza dipende dallo schermo ----------
  const H = 360;
  const GROUND = 300;          // y dei piedi
  const WORLD_W = 1800;        // larghezza del campo di battaglia
  const GATE_X = 150;          // porta del castello
  let W = 640, scale = 1, dpr = 1, safeL = 0, safeR = 0, portrait = false;

  function inset(name) { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0; }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cw = window.innerWidth, ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    scale = ch / H;
    W = cw / scale;
    safeL = inset('--sal') / scale; safeR = inset('--sar') / scale;
    portrait = ch > cw * 1.05;
  }
  window.addEventListener('resize', resize);

  // ---------- Storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  let best = store.get('ll2_best', 0);
  let bestWave = store.get('ll2_bestwave', 0);
  let muted = store.get('ll2_muted', false);

  // ---------- Audio sintetizzato ----------
  let actx = null;
  function initAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
  }
  function tone(freq, dur, type, vol, slide, delay) {
    if (muted || !actx) return;
    const t = actx.currentTime + (delay || 0);
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, freq) {
    if (muted || !actx) return;
    const len = Math.floor(actx.sampleRate * dur);
    const buf = actx.createBuffer(1, len, actx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = actx.createBufferSource(); src.buffer = buf;
    const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 1200;
    const g = actx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(actx.destination); src.start();
  }
  const sfx = {
    swing() { noise(0.12, 0.25, 2400); },
    hit() { tone(180, 0.08, 'square', 0.05, -80); noise(0.06, 0.2, 800); },
    clang() { tone(1400, 0.12, 'triangle', 0.05, -300); tone(2100, 0.1, 'sine', 0.03, -500); },
    die() { tone(220, 0.25, 'sawtooth', 0.05, -160); },
    hurt() { tone(140, 0.3, 'sawtooth', 0.08, -60); },
    wall() { noise(0.2, 0.3, 300); },
    arrow() { noise(0.08, 0.12, 3500); },
    horn() { tone(196, 0.5, 'sawtooth', 0.05, 0); tone(294, 0.6, 'sawtooth', 0.04, 0, 0.35); },
    fury() { tone(110, 0.6, 'sawtooth', 0.08, 220); noise(0.4, 0.3, 600); },
    pick() { tone(660, 0.12, 'triangle', 0.06, 300); }
  };
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

  // ---------- Grafica esterna (www/assets) ----------
  // Ogni immagine è un PNG con sfondo trasparente, personaggio di profilo rivolto a DESTRA, piedi sul bordo inferiore.
  // Si elencano in www/assets/art.js; se un file manca si usa il disegno segnaposto in codice.
  const ART = {};
  (window.ART_FILES || []).forEach(name => {
    const img = new Image();
    img.onload = () => { ART[name] = img; };
    img.src = 'assets/' + name + '.png';
  });
  // altezza a schermo (unità logiche) di ogni sprite
  const ART_H = { knight: 88, goblin: 48, orc: 74, archer: 62, bat: 40, boss: 135 };
  function drawSprite(img, x, footY, h, dir, o) {
    o = o || {};
    const w = img.width * h / img.height;
    ctx.save();
    ctx.translate(x + (o.dx || 0), footY + (o.dy || 0));
    ctx.scale(dir * (o.sx || 1), o.sy || 1);
    if (o.rot) ctx.rotate(o.rot);
    if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
    if (o.flash) ctx.filter = 'brightness(2.6)';
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
  }

  // ---------- Utils ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = t => 1 - (1 - t) * (1 - t);
  // rumore deterministico per paesaggio
  const hash = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

  // ---------- Stato ----------
  let state = 'menu';        // menu | play | upgrade | pause | over
  let stateTime = 0, time = 0;
  let knight, castle, enemies, arrows, particles, floaters, spawnQueue, waveClock, wave, score, shake, camX, banner, upgradeChoices, wallAlert;
  function setState(s) { state = s; stateTime = 0; }

  function makeKnight() {
    return { x: GATE_X + 90, dir: 1, hp: 100, maxHp: 100, dmg: 14, speed: 150, range: 62, blockMul: 0.15, regen: 0, furyGain: 1,
      fury: 0, state: 'idle', atkT: 0, combo: 0, queued: false, hitDone: false, blocking: false, hurtT: 0, inv: 0, deadT: 0,
      walk: 0, moving: false, specT: 0 };
  }
  function newGame() {
    knight = makeKnight();
    castle = { hp: 300, max: 300, hitT: 0 };
    enemies = []; arrows = []; particles = []; floaters = [];
    wave = 0; score = 0; shake = 0; camX = 0; wallAlert = 0;
    startWave();
    setState('play');
  }
  function startWave() {
    wave++;
    spawnQueue = buildWave(wave);
    waveClock = 0;
    banner = 2.4;
    sfx.horn();
  }

  // ---------- Nemici ----------
  const EDEF = {
    goblin: { hp: 30, speed: 86, dmg: 8, rate: 0.8, wind: 0.28, range: 26, w: 26, h: 40, score: 10, fury: 7 },
    orc:    { hp: 100, speed: 44, dmg: 19, rate: 1.4, wind: 0.42, range: 36, w: 44, h: 62, score: 30, fury: 12 },
    archer: { hp: 30, speed: 56, dmg: 10, rate: 1.9, wind: 0.45, range: 260, w: 24, h: 50, score: 20, fury: 9, ranged: true },
    bat:    { hp: 16, speed: 115, dmg: 7, rate: 0.9, wind: 0.2, range: 20, w: 30, h: 22, score: 12, fury: 5, flying: true },
    boss:   { hp: 800, speed: 34, dmg: 34, rate: 1.9, wind: 0.65, range: 62, w: 80, h: 110, score: 400, fury: 50 }
  };
  function pickType(n) {
    const w = [['goblin', 10], ['orc', n >= 2 ? 3 + n * 0.5 : 0], ['archer', n >= 2 ? 3 + n * 0.4 : 0], ['bat', n >= 3 ? 3 + n * 0.2 : 0]];
    let tot = 0; for (const [, v] of w) tot += v;
    let r = Math.random() * tot;
    for (const [k, v] of w) if ((r -= v) <= 0) return k;
    return 'goblin';
  }
  function buildWave(n) {
    // difficoltà: più nemici, più vicini, più resistenti e più forti a ogni ondata; dalla 4 compaiono gli élite
    const q = []; let t = 2;
    const mul = 1 + (n - 1) * 0.22;
    const dmul = 1 + (n - 1) * 0.08;
    const elite = () => n >= 4 && Math.random() < Math.min(0.35, 0.08 + (n - 4) * 0.03);
    if (n % 5 === 0) {
      q.push({ t, type: 'boss', mul: 1 + (n / 5 - 1) * 0.8, dmul });
      for (let i = 0; i < 6 + n; i++) { t += 1.6; q.push({ t, type: ['goblin', 'archer', 'orc'][i % 3], mul, dmul, elite: elite() }); }
      return q;
    }
    const count = 8 + Math.round(n * 3);
    const gap = Math.max(0.35, 1.3 - n * 0.07);
    let i = 0;
    while (i < count) {
      // a volte arrivano a gruppi
      const group = n >= 2 && Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 2) : 1;
      const type = pickType(n);
      for (let g = 0; g < group && i < count; g++, i++) q.push({ t: t + g * 0.35, type, mul, dmul, elite: elite() });
      t += gap * rand(0.6, 1.3) * group;
    }
    return q;
  }
  function spawn(s) {
    const d = EDEF[s.type];
    const el = !!s.elite;
    const hp = Math.round(d.hp * s.mul * (el ? 1.8 : 1));
    enemies.push({ type: s.type, d, elite: el, dmg: d.dmg * (s.dmul || 1) * (el ? 1.4 : 1), x: WORLD_W + 30 + rand(0, 20), y: d.flying ? GROUND - 90 : GROUND, hp, maxHp: hp,
      dir: -1, state: 'walk', t: rand(0, 5), wind: 0, atkCd: rand(0.2, 0.8), kb: 0, flash: 0, target: null, speed: d.speed * rand(0.9, 1.1) });
  }

  // ---------- Effetti ----------
  function burst(x, y, color, n, sp, grav) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(sp * 0.3, sp);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - sp * 0.3, life: rand(0.35, 0.8), max: 0.8, color, size: rand(1.5, 3.5), g: grav === undefined ? 500 : grav });
    }
  }
  function floater(x, y, text, color, size) { floaters.push({ x, y, text, color, life: 0.9, size: size || 13 }); }

  // ---------- Combattimento ----------
  function knightAlive() { return knight.state !== 'dead'; }

  function damageEnemy(e, dmg, kb) {
    e.hp -= dmg; e.flash = 0.1;
    if (kb) e.kb = kb * (e.type === 'boss' ? 0.25 : 1);
    knight.fury = Math.min(100, knight.fury + 2 * knight.furyGain);
    floater(e.x, e.y - e.d.h - 6, String(Math.round(dmg)), '#ffd9a0');
    burst(e.x, e.y - e.d.h * 0.55, '#c4202f', 6, 160);
    sfx.hit();
    if (e.hp <= 0) killEnemy(e);
  }
  function killEnemy(e) {
    e.dead = true;
    score += e.d.score * (e.elite ? 2 : 1);
    knight.fury = Math.min(100, knight.fury + e.d.fury * knight.furyGain);
    burst(e.x, e.y - e.d.h * 0.5, e.type === 'archer' ? '#d8d2c0' : '#8a1a24', e.type === 'boss' ? 50 : 14, e.type === 'boss' ? 300 : 200);
    shake = Math.max(shake, e.type === 'boss' ? 14 : 3);
    sfx.die();
    if (e.type === 'boss') vibrate(150);
  }
  function hurtKnight(dmg, fromX) {
    if (!knightAlive() || knight.inv > 0) return;
    const front = Math.sign(fromX - knight.x) === knight.dir || fromX === knight.x;
    if (knight.blocking && front) {
      dmg *= knight.blockMul;
      sfx.clang();
      burst(knight.x + knight.dir * 16, GROUND - 44, '#ffe7a0', 8, 160, 200);
      if (dmg < 1) return;
    } else {
      sfx.hurt(); vibrate(50);
      knight.hurtT = 0.25;
      burst(knight.x, GROUND - 40, '#c4202f', 10, 180);
    }
    knight.hp -= dmg;
    shake = Math.max(shake, 5);
    floater(knight.x, GROUND - 84, '-' + Math.round(dmg), '#ff6b6b');
    if (knight.hp <= 0) {
      knight.hp = 0; knight.state = 'dead'; knight.deadT = 8; knight.blocking = false;
      burst(knight.x, GROUND - 40, '#ff6a2a', 40, 260);
      floater(knight.x, GROUND - 100, 'Il cavaliere è caduto', '#ffb38a', 14);
    }
  }
  function hurtCastle(dmg) {
    castle.hp -= dmg; castle.hitT = 0.15; wallAlert = 1.5;
    sfx.wall();
    burst(GATE_X - 4, GROUND - rand(20, 120), '#8a7a70', 5, 120);
    if (castle.hp <= 0) {
      castle.hp = 0;
      if (score > best) { best = score; store.set('ll2_best', best); }
      if (wave > bestWave) { bestWave = wave; store.set('ll2_bestwave', bestWave); }
      shake = 18; vibrate(300);
      setState('over');
    }
  }

  function startSwing() {
    knight.state = 'attack'; knight.atkT = 0; knight.hitDone = false; knight.queued = false;
    sfx.swing();
  }
  function attackPressed() {
    if (state !== 'play' || !knightAlive() || knight.blocking) return;
    if (knight.state === 'attack') { if (knight.atkT > 0.12) knight.queued = true; return; }
    if (knight.state === 'special') return;
    knight.combo = 0; startSwing();
  }
  function specialPressed() {
    if (state !== 'play' || !knightAlive() || knight.fury < 100 || knight.state === 'special') return;
    knight.fury = 0; knight.state = 'special'; knight.specT = 0; knight.hitDone = false;
    sfx.fury(); shake = 8; vibrate(80);
  }

  const SWING = 0.34;
  function updateKnight(dt) {
    const k = knight;
    if (k.inv > 0) k.inv -= dt;
    if (k.hurtT > 0) k.hurtT -= dt;
    if (k.state === 'dead') {
      k.deadT -= dt;
      if (k.deadT <= 0) {
        Object.assign(k, { state: 'idle', hp: k.maxHp, x: GATE_X + 60, dir: 1, inv: 2 });
        floater(k.x, GROUND - 100, 'Il cavaliere ritorna!', '#ffe7a0', 14);
      }
      return;
    }
    if (k.regen) k.hp = Math.min(k.maxHp, k.hp + k.regen * dt);

    let inDir = 0;
    if (input.left) inDir -= 1;
    if (input.right) inDir += 1;
    k.blocking = input.block && k.state !== 'attack' && k.state !== 'special';
    if (input.attack) attackPressed();

    let speedMul = 1;
    if (k.blocking) speedMul = 0.4;
    if (k.state === 'attack') speedMul = 0.25;
    if (k.state === 'special') speedMul = 0;
    if (inDir && k.state !== 'attack' && k.state !== 'special') k.dir = inDir;
    k.moving = inDir !== 0 && speedMul > 0;
    k.x = clamp(k.x + inDir * k.speed * speedMul * dt, GATE_X + 20, WORLD_W - 200);
    if (k.moving) k.walk += dt * 11 * speedMul + dt * 2;

    if (k.state === 'attack') {
      k.atkT += dt;
      if (!k.hitDone && k.atkT >= 0.11) {
        k.hitDone = true;
        const heavy = k.combo === 2;
        const reach = k.range * (heavy ? 1.15 : 1);
        for (const e of enemies) {
          if (e.dead) continue;
          const dx = (e.x - k.x) * k.dir;
          if (dx > -12 && dx < reach + e.d.w / 2 && e.y > GROUND - 130) {
            damageEnemy(e, k.dmg * (heavy ? 1.8 : 1) * rand(0.9, 1.1), heavy ? 220 * k.dir : 50 * k.dir);
          }
        }
        if (heavy) shake = Math.max(shake, 3);
      }
      if (k.atkT >= SWING) {
        if ((k.queued || input.attack) && k.combo < 2) { k.combo++; startSwing(); }
        else { k.state = 'idle'; k.combo = 0; }
      }
    } else if (k.state === 'special') {
      k.specT += dt;
      if (!k.hitDone && k.specT >= 0.25) {
        k.hitDone = true;
        for (const e of enemies) {
          if (e.dead) continue;
          if (Math.abs(e.x - k.x) < 130) damageEnemy(e, k.dmg * 3, 260 * Math.sign(e.x - k.x || 1));
        }
        burst(k.x, GROUND - 30, '#ff6a2a', 40, 320, 300);
        shake = 12;
      }
      if (k.specT >= 0.6) k.state = 'idle';
    }
  }

  function updateEnemy(e, dt) {
    const d = e.d;
    e.t += dt;
    if (e.flash > 0) e.flash -= dt;
    if (e.kb) { e.x += e.kb * dt; e.kb *= Math.pow(0.02, dt); if (Math.abs(e.kb) < 5) e.kb = 0; }
    e.x = Math.min(e.x, WORLD_W + 80);

    const alive = knightAlive();
    const dxK = knight.x - e.x;
    let target = null;
    if (d.flying) {
      e.y = GROUND - 92 + Math.sin(e.t * 4) * 10;
      if (e.x <= GATE_X + 14) target = 'castle';
    } else if (d.ranged) {
      if (alive && dxK < 0 && -dxK < d.range) target = 'knight';
      else if (e.x - GATE_X < d.range) target = 'castle';
    } else {
      if (alive && Math.abs(dxK) < d.range + 14) { target = 'knight'; e.dir = Math.sign(dxK) || -1; }
      else if (e.x <= GATE_X + d.w / 2 + 4) target = 'castle';
    }
    if (!target) e.dir = -1;
    e.target = target;

    if (e.state === 'windup') {
      e.wind -= dt;
      if (e.wind <= 0) {
        e.state = 'walk';
        e.atkCd = d.rate;
        e.strikeT = 0.15;
        if (d.ranged) {
          const tx = target === 'knight' ? knight.x : GATE_X - 10;
          const ty = target === 'knight' ? GROUND - 40 : GROUND - rand(30, 110);
          shootArrow(e, tx, ty);
        } else if (target === 'knight' && Math.abs(knight.x - e.x) < d.range + 18) {
          hurtKnight(e.dmg, e.x);
        } else if (target === 'castle') {
          hurtCastle(e.dmg);
        }
        if (e.type === 'boss') { shake = Math.max(shake, 8); burst(e.x + e.dir * 50, GROUND, '#6b5a50', 16, 200); }
      }
      return;
    }
    if (e.strikeT > 0) e.strikeT -= dt;
    if (target) {
      e.atkCd -= dt;
      if (e.atkCd <= 0) { e.state = 'windup'; e.wind = d.wind; }
    } else if (!e.kb) {
      e.x -= e.speed * dt;
    }
  }

  function shootArrow(e, tx, ty) {
    const sx = e.x - 10, sy = e.y - 36;
    const dist = Math.max(40, sx - tx);
    const vx = -320, T = dist / 320, g = 260;
    const vy = (ty - sy) / T - 0.5 * g * T;
    arrows.push({ x: sx, y: sy, vx, vy, g, dmg: e.dmg, from: e.x });
    sfx.arrow();
  }

  function keepSpacing() {
    // i nemici a terra si mettono in fila invece di sovrapporsi
    const ground = enemies.filter(e => !e.d.flying && !e.dead).sort((a, b) => a.x - b.x);
    for (let i = 1; i < ground.length; i++) {
      const a = ground[i - 1], b = ground[i];
      const gap = (a.d.w + b.d.w) * 0.42;
      if (b.x - a.x < gap) b.x = a.x + gap;
    }
  }

  // ---------- Upgrade ----------
  const UPGRADES = [
    { name: 'Lama affilata', desc: '+20% danno', apply: () => { knight.dmg *= 1.2; } },
    { name: 'Armatura pesante', desc: '+25 vita massima', apply: () => { knight.maxHp += 25; knight.hp += 25; } },
    { name: 'Passo rapido', desc: '+12% velocità', apply: () => { knight.speed *= 1.12; }, ok: () => knight.speed < 230 },
    { name: 'Spada lunga', desc: '+15% portata', apply: () => { knight.range *= 1.15; }, ok: () => knight.range < 100 },
    { name: 'Scudo temprato', desc: 'La parata blocca di più', apply: () => { knight.blockMul *= 0.5; }, ok: () => knight.blockMul > 0.03 },
    { name: 'Sete di sangue', desc: 'La Furia si carica +40%', apply: () => { knight.furyGain *= 1.4; }, ok: () => knight.furyGain < 3 },
    { name: 'Rigenerazione', desc: '+2 vita al secondo', apply: () => { knight.regen += 2; }, ok: () => knight.regen < 8 },
    { name: 'Ripara le mura', desc: 'Castello +40% vita', apply: () => { castle.hp = Math.min(castle.max, castle.hp + castle.max * 0.4); }, ok: () => castle.hp < castle.max * 0.9 },
    { name: 'Mura rinforzate', desc: '+80 vita massima alle mura', apply: () => { castle.max += 80; castle.hp += 80; } }
  ];
  function rollUpgrades() {
    const pool = UPGRADES.filter(u => !u.ok || u.ok());
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    upgradeChoices = pool.slice(0, 3);
    // se le mura sono messe male, la riparazione è sempre tra le scelte
    const repair = UPGRADES[7];
    if (castle.hp < castle.max * 0.5 && !upgradeChoices.includes(repair)) upgradeChoices[2] = repair;
  }
  function cardRect(i) {
    const gap = 16, w = Math.min(200, (W - 80 - gap * 2) / 3), h = 130;
    const x0 = W / 2 - (w * 3 + gap * 2) / 2;
    return { x: x0 + i * (w + gap), y: H / 2 - 40, w, h };
  }
  function chooseUpgrade(i) {
    const u = upgradeChoices[i]; if (!u) return;
    u.apply(); sfx.pick();
    knight.hp = Math.min(knight.maxHp, knight.hp + knight.maxHp * 0.15);
    startWave(); setState('play');
  }

  // ---------- Input ----------
  const input = { left: false, right: false, attack: false, block: false };
  const keys = {};
  const pointers = new Map();     // pointerId -> nome pulsante
  function buttons() {
    const bl = safeL + 16, br = W - safeR - 16;
    return {
      left:    { x: bl + 42, y: H - 52, r: 36 },
      right:   { x: bl + 132, y: H - 52, r: 36 },
      attack:  { x: br - 48, y: H - 56, r: 42 },
      block:   { x: br - 140, y: H - 40, r: 30 },
      special: { x: br - 50, y: H - 150, r: 28 }
    };
  }
  const PAUSE_BTN = () => ({ x: W - safeR - 30, y: 26, r: 18 });
  function toLogical(e) { return { x: e.clientX / scale, y: e.clientY / scale }; }
  function hitButton(p) {
    const b = buttons();
    let bestName = null, bestD = Infinity;
    for (const name in b) {
      const q = b[name], d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < q.r + 18 && d < bestD) { bestD = d; bestName = name; }
    }
    // zona movimento: metà sinistra bassa dello schermo
    if (!bestName && p.x < W * 0.4 && p.y > H * 0.45) bestName = p.x < b.left.x + (b.right.x - b.left.x) / 2 ? 'left' : 'right';
    return bestName;
  }
  function refreshInput() {
    input.left = input.right = input.attack = input.block = false;
    for (const name of pointers.values()) {
      if (name === 'left' || name === 'right' || name === 'attack' || name === 'block') input[name] = true;
    }
    if (keys.ArrowLeft || keys.a || keys.A) input.left = true;
    if (keys.ArrowRight || keys.d || keys.D) input.right = true;
    if (keys.j || keys.J || keys[' ']) input.attack = true;
    if (keys.k || keys.K || keys.Shift) input.block = true;
  }

  canvas.addEventListener('pointerdown', e => {
    initAudio();
    const p = toLogical(e);
    if (state === 'play' && !portrait) {
      const pb = PAUSE_BTN();
      if (Math.hypot(p.x - pb.x, p.y - pb.y) < pb.r + 12) { pause(); return; }
      const name = hitButton(p);
      if (!name) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (name === 'special') { specialPressed(); return; }
      pointers.set(e.pointerId, name);
      refreshInput();
      if (name === 'attack') attackPressed();
      return;
    }
    handleTap(p);
  });
  canvas.addEventListener('pointermove', e => {
    const cur = pointers.get(e.pointerId);
    if (cur !== 'left' && cur !== 'right') return;
    const name = hitButton(toLogical(e));
    if ((name === 'left' || name === 'right') && name !== cur) { pointers.set(e.pointerId, name); refreshInput(); }
  });
  const release = e => { if (pointers.delete(e.pointerId)) refreshInput(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    keys[e.key] = true; refreshInput();
    initAudio();
    if (e.key === 'j' || e.key === 'J' || e.key === ' ') attackPressed();
    if (e.key === 'l' || e.key === 'L' || e.key === 'e') specialPressed();
    if (e.key === 'Escape' || e.key === 'p') { if (state === 'play') pause(); else if (state === 'pause') resume(); }
    if (e.key === 'Enter' && (state === 'menu' || (state === 'over' && stateTime > 1))) newGame();
    if (state === 'upgrade' && stateTime > 0.6 && ['1', '2', '3'].includes(e.key)) chooseUpgrade(+e.key - 1);
  });
  window.addEventListener('keyup', e => { keys[e.key] = false; refreshInput(); });

  function pause() { if (state !== 'play') return; pointers.clear(); refreshInput(); setState('pause'); }
  function resume() { setState('play'); }

  const MUTE_BTN = () => ({ x: W / 2 - 70, y: H - 64, w: 140, h: 36 });
  function pauseButtons() {
    return [
      { label: 'Riprendi', act: resume, x: W / 2 - 90, y: H / 2 - 20, w: 180, h: 46 },
      { label: 'Menu', act: () => setState('menu'), x: W / 2 - 90, y: H / 2 + 38, w: 180, h: 46 }
    ];
  }
  const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  function handleTap(p) {
    if (portrait) return;
    if (state === 'menu') {
      if (inRect(p, MUTE_BTN())) { muted = !muted; store.set('ll2_muted', muted); return; }
      newGame();
    } else if (state === 'over') { if (stateTime > 1) newGame(); }
    else if (state === 'pause') { for (const b of pauseButtons()) if (inRect(p, b)) { b.act(); return; } }
    else if (state === 'upgrade') {
      if (stateTime < 0.6) return;
      for (let i = 0; i < upgradeChoices.length; i++) if (inRect(p, cardRect(i))) { chooseUpgrade(i); return; }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pause(); if (actx && actx.state === 'running') actx.suspend(); }
  });
  try {
    const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (AppPlugin) {
      AppPlugin.addListener('backButton', () => {
        if (state === 'play') pause(); else if (state === 'pause') resume();
        else if (state === 'over' || state === 'upgrade') setState('menu');
        else if (state === 'menu') AppPlugin.exitApp();
      });
      AppPlugin.addListener('pause', () => pause());
    }
  } catch (e) { /* non in app nativa */ }

  // ---------- Update ----------
  function update(dt) {
    stateTime += dt;
    if (state === 'pause' || state === 'menu' || portrait) return;

    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt;
      if (q.y > GROUND + 6) { q.y = GROUND + 6; q.vy *= -0.3; q.vx *= 0.6; }
      if (q.life <= 0) particles.splice(i, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) { const f = floaters[i]; f.y -= 34 * dt; f.life -= dt; if (f.life <= 0) floaters.splice(i, 1); }
    shake = Math.max(0, shake - 30 * dt);
    if (state !== 'play') return;

    if (banner > 0) banner -= dt;
    if (castle.hitT > 0) castle.hitT -= dt;
    if (wallAlert > 0) wallAlert -= dt;

    updateKnight(dt);

    waveClock += dt;
    while (spawnQueue.length && spawnQueue[0].t <= waveClock) spawn(spawnQueue.shift());

    for (const e of enemies) if (!e.dead) updateEnemy(e, dt);
    if (state !== 'play') return;
    keepSpacing();
    enemies = enemies.filter(e => !e.dead);

    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      a.vy += a.g * dt; a.x += a.vx * dt; a.y += a.vy * dt;
      if (knightAlive() && Math.abs(a.x - knight.x) < 12 && a.y > GROUND - 76 && a.y < GROUND) {
        arrows.splice(i, 1); hurtKnight(a.dmg, a.from); if (state !== 'play') return; continue;
      }
      if (a.x <= GATE_X) { arrows.splice(i, 1); hurtCastle(a.dmg); if (state !== 'play') return; continue; }
      if (a.y > GROUND + 4) arrows.splice(i, 1);
    }

    const target = clamp(knight.x - W * 0.42, 0, Math.max(0, WORLD_W - W));
    camX = lerp(camX, target, Math.min(1, dt * 6));

    if (!spawnQueue.length && !enemies.length) {
      arrows = []; pointers.clear(); refreshInput();
      score += wave * 50;
      if (!knightAlive()) Object.assign(knight, { state: 'idle', hp: knight.maxHp * 0.5, x: GATE_X + 60, deadT: 0 });
      knight.state = 'idle'; knight.blocking = false;
      rollUpgrades();
      setState('upgrade');
    }
  }

  // =====================================================================
  //  RENDER
  // =====================================================================
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function text(str, x, y, size, color, align, weight, font) {
    ctx.font = (weight || '700') + ' ' + size + 'px ' + (font || 'Georgia, "Times New Roman", serif');
    ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = color; ctx.fillText(str, x, y);
  }
  function shadowText(str, x, y, size, color, align, weight) {
    text(str, x + 1.5, y + 1.5, size, 'rgba(0,0,0,.7)', align, weight);
    text(str, x, y, size, color, align, weight);
  }

  // ---------- Paesaggio ----------
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND);
    g.addColorStop(0, '#120c22'); g.addColorStop(0.55, '#3a1c38'); g.addColorStop(1, '#6a2c34');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // luna
    const mx = W * 0.72 - camX * 0.03, my = 70;
    const mg = ctx.createRadialGradient(mx, my, 10, mx, my, 90);
    mg.addColorStop(0, 'rgba(255,200,170,.35)'); mg.addColorStop(1, 'rgba(255,200,170,0)');
    ctx.fillStyle = mg; ctx.fillRect(mx - 90, my - 90, 180, 180);
    ctx.fillStyle = '#f4d2bc'; ctx.beginPath(); ctx.arc(mx, my, 24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(180,120,110,.35)'; ctx.beginPath(); ctx.arc(mx - 7, my - 4, 6, 0, Math.PI * 2); ctx.arc(mx + 8, my + 7, 4, 0, Math.PI * 2); ctx.fill();
  }
  function layer(par, baseY, amp, step, color, seed) {
    const off = camX * par;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, H);
    const i0 = Math.floor(off / step) - 1, i1 = Math.ceil((off + W) / step) + 1;
    for (let i = i0; i <= i1; i++) {
      const x = i * step - off;
      const y = baseY - (hash(i + seed) * 0.6 + hash(i * 0.37 + seed * 3) * 0.4) * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  function drawTrees(par, color) {
    const off = camX * par;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round';
    for (let i = Math.floor(off / 140) - 1; i <= Math.ceil((off + W) / 140) + 1; i++) {
      if (hash(i * 7.1) < 0.45) continue;
      const x = i * 140 + hash(i) * 80 - off, base = 262 + hash(i * 3) * 10, h = 40 + hash(i * 5) * 40;
      ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + 2, base - h); ctx.stroke();
      ctx.lineWidth = 2;
      for (let b = 0; b < 4; b++) {
        const by = base - h * (0.45 + b * 0.15), s = (b % 2 ? 1 : -1);
        ctx.beginPath(); ctx.moveTo(x + 1, by); ctx.lineTo(x + s * (12 + hash(i + b) * 10), by - 10 - hash(i * b) * 8); ctx.stroke();
      }
    }
  }
  function drawGround() {
    const g = ctx.createLinearGradient(0, GROUND - 6, 0, H);
    g.addColorStop(0, '#3a2a24'); g.addColorStop(1, '#16100e');
    ctx.fillStyle = g; ctx.fillRect(0, GROUND - 4, W, H - GROUND + 4);
    ctx.fillStyle = '#4a3529'; ctx.fillRect(0, GROUND - 4, W, 3);
    // sassi e ciuffi (coordinate mondo)
    for (let i = Math.floor(camX / 37) - 1; i <= Math.ceil((camX + W) / 37) + 1; i++) {
      const x = i * 37 + hash(i * 2.3) * 30 - camX, y = GROUND + 4 + hash(i * 4.1) * 50;
      ctx.fillStyle = hash(i) > 0.5 ? '#2a1e19' : '#4a382c';
      ctx.fillRect(x, y, 2 + hash(i * 9) * 5, 2 + hash(i * 6) * 2);
      if (hash(i * 1.7) > 0.6) {
        ctx.strokeStyle = '#3a3a24'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, GROUND - 2); ctx.lineTo(x - 3, GROUND - 9); ctx.moveTo(x + 2, GROUND - 2); ctx.lineTo(x + 3, GROUND - 11); ctx.moveTo(x + 4, GROUND - 2); ctx.lineTo(x + 8, GROUND - 7); ctx.stroke();
      }
    }
  }

  // ---------- Castello ----------
  function drawCastle() {
    const ox = -camX;
    if (ox + GATE_X < -10) return;
    if (ART.castle) {
      const h = 250, w = ART.castle.width * h / ART.castle.height;
      ctx.drawImage(ART.castle, ox + GATE_X + 6 - w, GROUND + 4 - h, w, h);
      if (castle && castle.hitT > 0) { ctx.fillStyle = 'rgba(255,80,60,.2)'; ctx.fillRect(ox + GATE_X + 6 - w, GROUND + 4 - h, w, h); }
      return;
    }
    ctx.save(); ctx.translate(ox, 0);
    const top = GROUND - 150;
    const stone = ctx.createLinearGradient(0, 0, GATE_X, 0);
    stone.addColorStop(0, '#4a4248'); stone.addColorStop(1, '#6a5e60');
    // torre
    ctx.fillStyle = '#3e373d'; ctx.fillRect(10, GROUND - 210, 76, 210);
    for (let i = 0; i < 4; i++) ctx.fillRect(10 + i * 21, GROUND - 224, 13, 16);
    // mura
    ctx.fillStyle = stone; ctx.fillRect(-30, top, GATE_X + 30, 150);
    for (let i = 0; i < 9; i++) ctx.fillRect(-30 + i * 22, top - 14, 13, 16);
    // pietre
    ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1;
    for (let r = 0; r < 10; r++) {
      const y = top + r * 15;
      ctx.beginPath(); ctx.moveTo(-30, y); ctx.lineTo(GATE_X, y); ctx.stroke();
      for (let c = 0; c < 8; c++) { const x = -30 + c * 24 + (r % 2) * 12; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 15); ctx.stroke(); }
    }
    // finestra della torre
    ctx.fillStyle = '#ffb35a'; ctx.globalAlpha = 0.6 + Math.sin(time * 7) * 0.1; ctx.fillRect(42, GROUND - 180, 10, 18); ctx.globalAlpha = 1;
    // porta
    ctx.fillStyle = '#1a1210'; ctx.beginPath(); ctx.moveTo(96, GROUND); ctx.lineTo(96, GROUND - 56); ctx.arc(120, GROUND - 56, 24, Math.PI, 0); ctx.lineTo(144, GROUND); ctx.fill();
    ctx.strokeStyle = '#3a2618'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(100 + i * 10, GROUND); ctx.lineTo(100 + i * 10, GROUND - 70); ctx.stroke(); }
    // stendardo
    const wv = Math.sin(time * 3) * 3;
    ctx.fillStyle = '#7a1622';
    ctx.beginPath(); ctx.moveTo(48, GROUND - 236); ctx.lineTo(72 + wv, GROUND - 232); ctx.lineTo(70 + wv, GROUND - 216); ctx.lineTo(48, GROUND - 220); ctx.fill();
    ctx.strokeStyle = '#2a2024'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(48, GROUND - 210); ctx.lineTo(48, GROUND - 244); ctx.stroke();
    // torce
    for (const tx of [88, 152]) {
      const fl = 0.8 + Math.sin(time * 13 + tx) * 0.2;
      const tg = ctx.createRadialGradient(tx, GROUND - 82, 2, tx, GROUND - 82, 40 * fl);
      tg.addColorStop(0, 'rgba(255,170,80,.55)'); tg.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = tg; ctx.fillRect(tx - 40, GROUND - 122, 80, 80);
      ctx.fillStyle = '#ffcf7a'; ctx.beginPath(); ctx.ellipse(tx, GROUND - 84, 3, 6 * fl, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3a2618'; ctx.fillRect(tx - 2, GROUND - 78, 4, 10);
    }
    // crepe
    const dmg = castle ? 1 - castle.hp / castle.max : 0;
    if (dmg > 0.3) {
      ctx.strokeStyle = 'rgba(10,6,6,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(60, top + 10); ctx.lineTo(54, top + 40); ctx.lineTo(64, top + 62); ctx.lineTo(58, top + 90); ctx.stroke();
      if (dmg > 0.6) { ctx.beginPath(); ctx.moveTo(10, top + 30); ctx.lineTo(24, top + 60); ctx.lineTo(16, top + 100); ctx.moveTo(130, top + 20); ctx.lineTo(120, top + 50); ctx.stroke(); }
    }
    if (castle && castle.hitT > 0) { ctx.fillStyle = 'rgba(255,80,60,.25)'; ctx.fillRect(-30, top - 14, GATE_X + 30, 164); }
    ctx.restore();
  }

  // ---------- Cavaliere (segnaposto disegnato in codice, da sostituire con la grafica definitiva) ----------
  const K = { armor: '#8e1c26', armorHi: '#c8434a', armorDk: '#4a0b12', steel: '#2a2228', trim: '#c9a050', glow: '#ff7a2a', cape: '#3a0c14' };
  function limb(x1, y1, x2, y2, w, color) {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function swordAngle(k) {
    if (k.state === 'attack') {
      const t = clamp(k.atkT / SWING, 0, 1), e = easeOut(Math.min(1, t * 1.6));
      if (k.combo === 0) return lerp(-2.3, 1.2, e);
      if (k.combo === 1) return lerp(1.3, -1.6, e);
      return lerp(-0.4, 1.35, e);
    }
    if (k.state === 'special') return k.specT * 22;
    if (k.blocking) return -0.9;
    return 0.55 + Math.sin(time * 2) * 0.04;
  }
  function drawKnight() {
    const k = knight;
    if (k.state === 'dead') {
      // elmo a terra e luce che si spegne
      const x = k.x - camX;
      ctx.globalAlpha = clamp(k.deadT / 8, 0.2, 1);
      ctx.fillStyle = K.armorDk; ctx.beginPath(); ctx.ellipse(x, GROUND - 6, 16, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    if (k.inv > 0 && Math.floor(k.inv * 14) % 2 === 0) return;
    const x = k.x - camX;
    const bob = k.moving ? Math.abs(Math.sin(k.walk)) * 2 : Math.sin(time * 2.2) * 0.8;
    if (ART.knight) { drawKnightSprite(k, x, bob); return; }
    const ls = k.moving ? Math.sin(k.walk) * 0.6 : 0;
    ctx.save();
    ctx.translate(x, GROUND);
    // ombra
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(0, 1, 22, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.scale(k.dir, 1);
    if (k.state === 'special') ctx.rotate(Math.sin(k.specT * 20) * 0.08);
    const hipY = -30 - bob;

    // mantello
    const sway = Math.sin(time * 3 + k.x * 0.02) * 3 + (k.moving ? 6 : 0);
    const cg = ctx.createLinearGradient(-30, -60, 0, 0);
    cg.addColorStop(0, '#16050a'); cg.addColorStop(1, K.cape);
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.moveTo(-6, -60 - bob); ctx.quadraticCurveTo(-24 - sway, -36, -26 - sway, -6 - bob * 0.5);
    ctx.lineTo(-18 - sway, -10); ctx.lineTo(-14 - sway * 0.6, -3); ctx.lineTo(-8, -8); ctx.quadraticCurveTo(-6, -34, 4, -58 - bob); ctx.fill();

    // gambe
    const legs = (ph, col) => {
      const kx = Math.sin(ph) * 10, ky = hipY + 16;
      const fx = Math.sin(ph) * 14 + 2, fy = -3;
      limb(0, hipY, kx, ky, 8, col); limb(kx, ky, fx, fy, 7, col);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(fx - 5, -5); ctx.lineTo(fx + 9, -3); ctx.lineTo(fx + 8, 0); ctx.lineTo(fx - 6, 0); ctx.fill();
      ctx.fillStyle = K.trim; ctx.beginPath(); ctx.arc(kx, ky, 2.4, 0, Math.PI * 2); ctx.fill();
    };
    legs(ls + Math.PI, K.armorDk);
    legs(ls, K.armor);

    // braccio della spada (dietro al busto se a riposo)
    const sa = swordAngle(k);
    const shX = 4, shY = -54 - bob;
    const drawSwordArm = () => {
      const hx = shX + Math.sin(sa) * 16, hy = shY + Math.cos(sa) * 10 + 8;
      limb(shX, shY, hx, hy, 7, K.armorDk);
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(sa - Math.PI / 2 + 0.2);
      ctx.fillStyle = K.trim; ctx.fillRect(-1.5, -6, 3, 12);
      const bg = ctx.createLinearGradient(0, -2, 0, 2); bg.addColorStop(0, '#f2f4f7'); bg.addColorStop(1, '#8a929c');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.moveTo(2, -2.2); ctx.lineTo(38, -1.2); ctx.lineTo(43, 0); ctx.lineTo(38, 1.2); ctx.lineTo(2, 2.2); ctx.fill();
      ctx.fillStyle = '#2a1a12'; ctx.fillRect(-8, -1.6, 8, 3.2);
      ctx.fillStyle = K.trim; ctx.beginPath(); ctx.arc(-9, 0, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = K.steel; ctx.beginPath(); ctx.arc(hx, hy, 3.6, 0, Math.PI * 2); ctx.fill();
    };
    if (k.state !== 'attack' && k.state !== 'special') drawSwordArm();

    // busto
    const tg = ctx.createLinearGradient(-12, 0, 12, 0);
    tg.addColorStop(0, K.armorDk); tg.addColorStop(0.55, K.armor); tg.addColorStop(1, K.armorHi);
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.moveTo(-11, -60 - bob); ctx.quadraticCurveTo(2, -66 - bob, 13, -58 - bob); ctx.lineTo(10, hipY); ctx.lineTo(-9, hipY); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = K.trim; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-9, hipY + 1); ctx.lineTo(10, hipY + 1); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.moveTo(3, -62 - bob); ctx.lineTo(2, hipY); ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,110,40,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-6, -44 - bob); ctx.lineTo(9, -44 - bob); ctx.moveTo(-6, -38 - bob); ctx.lineTo(9, -38 - bob); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    // falda di stoffa
    ctx.fillStyle = K.cape;
    ctx.beginPath(); ctx.moveTo(-4, hipY); ctx.lineTo(8, hipY); ctx.lineTo(7 + ls * 2, hipY + 18); ctx.lineTo(3, hipY + 13); ctx.lineTo(-1 + ls * 2, hipY + 19); ctx.closePath(); ctx.fill();

    // spallaccio con punte
    ctx.fillStyle = K.armor;
    ctx.beginPath(); ctx.ellipse(-2, -58 - bob, 9, 6.5, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = K.armorDk;
    ctx.beginPath(); ctx.moveTo(-9, -62 - bob); ctx.lineTo(-17, -74 - bob); ctx.lineTo(-4, -63 - bob); ctx.moveTo(-3, -64 - bob); ctx.lineTo(-7, -78 - bob); ctx.lineTo(2, -64 - bob); ctx.fill();

    // elmo
    const hy = -70 - bob;
    ctx.fillStyle = K.armorDk;
    ctx.beginPath(); ctx.moveTo(-1, hy - 6); ctx.quadraticCurveTo(-10, hy - 18, -6, hy - 30); ctx.quadraticCurveTo(-4, hy - 18, 4, hy - 8); ctx.fill();
    ctx.beginPath(); ctx.moveTo(4, hy - 7); ctx.quadraticCurveTo(6, hy - 20, 16, hy - 26); ctx.quadraticCurveTo(10, hy - 16, 9, hy - 5); ctx.fill();
    const hg = ctx.createLinearGradient(-8, hy - 10, 10, hy + 8);
    hg.addColorStop(0, K.armorHi); hg.addColorStop(1, K.armorDk);
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.moveTo(-8, hy + 6); ctx.quadraticCurveTo(-10, hy - 10, 2, hy - 10); ctx.quadraticCurveTo(11, hy - 9, 12, hy - 1); ctx.lineTo(15, hy + 4); ctx.quadraticCurveTo(10, hy + 10, 4, hy + 11); ctx.closePath(); ctx.fill();
    // fessura luminosa
    ctx.globalCompositeOperation = 'lighter';
    const eg = ctx.createRadialGradient(9, hy, 0, 9, hy, 9);
    eg.addColorStop(0, 'rgba(255,140,60,.9)'); eg.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = eg; ctx.fillRect(0, hy - 9, 18, 18);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffd08a'; ctx.beginPath(); ctx.moveTo(4, hy - 1); ctx.lineTo(14, hy); ctx.lineTo(5, hy + 1.6); ctx.fill();

    // scudo
    const sx = k.blocking ? 15 : 9, sy = k.blocking ? -52 - bob : -44 - bob;
    ctx.save(); ctx.translate(sx, sy); if (k.blocking) ctx.rotate(-0.15);
    const sg = ctx.createLinearGradient(-6, -12, 8, 14);
    sg.addColorStop(0, '#5a1a22'); sg.addColorStop(1, '#22060b');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.moveTo(-7, -13); ctx.lineTo(7, -13); ctx.lineTo(7, 2); ctx.quadraticCurveTo(6, 11, 0, 16); ctx.quadraticCurveTo(-6, 11, -7, 2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = K.trim; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = K.trim; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(3, 0); ctx.lineTo(0, 8); ctx.lineTo(-3, 0); ctx.fill();
    ctx.restore();

    if (k.state === 'attack' || k.state === 'special') drawSwordArm();

    // scia del fendente
    if ((k.state === 'attack' && k.atkT < 0.22) || (k.state === 'special' && k.specT < 0.45)) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = k.state === 'special' ? 'rgba(255,120,40,.7)' : 'rgba(255,220,190,.55)';
      ctx.lineWidth = k.state === 'special' ? 6 : 3;
      ctx.beginPath();
      if (k.state === 'special') ctx.arc(0, -40, 48, 0, Math.PI * 2);
      else ctx.arc(shX, shY + 8, 44, -1.4, 1.1);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (k.hurtT > 0) { ctx.globalAlpha = k.hurtT * 2; ctx.fillStyle = '#fff'; ctx.fillRect(-14, -84, 30, 84); ctx.globalAlpha = 1; }
    ctx.restore();
  }

  function drawKnightSprite(k, x, bob) {
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(x, GROUND + 1, 24, 5, 0, 0, Math.PI * 2); ctx.fill();
    let rot = k.moving ? Math.sin(k.walk) * 0.04 : 0, dx = 0, sx = 1, sy = 1 - bob * 0.006;
    if (k.state === 'attack') {
      const t = clamp(k.atkT / SWING, 0, 1);
      rot = t < 0.3 ? lerp(0, -0.12, t / 0.3) : lerp(-0.12, 0.16, easeOut(Math.min(1, (t - 0.3) / 0.4)));
      dx = (t < 0.3 ? -2 : 6) * k.dir;
    } else if (k.state === 'special') { sx = Math.cos(k.specT * 20); }
    else if (k.blocking) { rot = -0.06; sy = 0.97; }
    drawSprite(ART.knight, x, GROUND, ART_H.knight, k.dir, { rot, dx, sx, sy, flash: k.hurtT > 0 });
    if ((k.state === 'attack' && k.atkT < 0.22) || (k.state === 'special' && k.specT < 0.45)) {
      ctx.save(); ctx.translate(x, GROUND); ctx.scale(k.dir, 1);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = k.state === 'special' ? 'rgba(255,120,40,.75)' : 'rgba(255,220,190,.6)';
      ctx.lineWidth = k.state === 'special' ? 6 : 3.5;
      ctx.beginPath();
      if (k.state === 'special') ctx.arc(0, -44, 54, 0, Math.PI * 2); else ctx.arc(10, -46, 48, -1.4, 1.1);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawEnemySprite(e, x, img) {
    const d = e.d, h = ART_H[e.type] * (e.elite ? 1.15 : 1);
    const walk = e.state === 'walk' && !e.target ? e.t * 9 : 0;
    const wind = e.state === 'windup' ? 1 - e.wind / d.wind : 0;
    let rot = Math.sin(walk) * 0.06, dy = -Math.abs(Math.sin(walk)) * 2;
    if (wind) rot = -0.16 * wind;
    if (e.strikeT > 0) rot = 0.2;
    if (d.flying) { dy = h / 2; rot = Math.sin(e.t * 18) * 0.12; }
    if (!d.flying) { ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(x, GROUND + 1, d.w * 0.6, 4, 0, 0, Math.PI * 2); ctx.fill(); }
    drawSprite(img, x, e.y, h, e.dir, { rot, dy, flash: e.flash > 0 });
  }

  // ---------- Nemici (segnaposto) ----------
  function drawEnemy(e) {
    const x = e.x - camX;
    if (x < -120 || x > W + 120) return;
    const d = e.d;
    const walk = e.state === 'walk' && !e.target ? e.t * 9 : 0;
    const ls = Math.sin(walk) * 0.7;
    const wind = e.state === 'windup' ? 1 - e.wind / d.wind : 0;
    const strike = e.strikeT > 0 ? 1 : 0;
    if (e.elite) {
      // alone rosso pulsante
      ctx.globalCompositeOperation = 'lighter';
      const ag = ctx.createRadialGradient(x, e.y - d.h * 0.5, 2, x, e.y - d.h * 0.5, d.h * 0.9);
      ag.addColorStop(0, 'rgba(255,40,30,' + (0.28 + Math.sin(time * 6) * 0.08) + ')'); ag.addColorStop(1, 'rgba(255,40,30,0)');
      ctx.fillStyle = ag; ctx.fillRect(x - d.h, e.y - d.h * 1.5, d.h * 2, d.h * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    const img = ART[e.type];
    if (img) drawEnemySprite(e, x, img);
    ctx.save();
    ctx.translate(x, e.y);
    if (e.elite && !img) ctx.scale(1.15, 1.15);
    if (!d.flying) { ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(0, 1, d.w * 0.55, 4, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.scale(-e.dir, 1);   // disegnati rivolti a sinistra
    const flash = e.flash > 0;
    const col = c => flash ? '#ffffff' : c;

    if (img) { /* sprite già disegnato */ } else if (e.type === 'goblin') {
      const b = Math.abs(Math.sin(walk)) * 2;
      limb(2, -14, 2 + ls * 7, -1, 5, col('#2f4a22')); limb(-4, -14, -4 - ls * 7, -1, 5, col('#3b5a2a'));
      ctx.fillStyle = col('#4f7a3a'); ctx.beginPath(); ctx.ellipse(0, -22 - b, 10, 11, 0.25, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col('#5a3a22'); ctx.fillRect(-9, -18 - b, 18, 5);
      ctx.fillStyle = col('#5f8f45'); ctx.beginPath(); ctx.arc(-6, -35 - b, 8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-2, -38 - b); ctx.lineTo(10, -44 - b); ctx.lineTo(1, -33 - b); ctx.fill();
      ctx.fillStyle = '#ffd23a'; ctx.fillRect(-12, -37 - b, 3, 2);
      const aa = wind ? -1.6 * wind : strike ? 1.2 : 0.3;
      ctx.save(); ctx.translate(-6, -24 - b); ctx.rotate(aa);
      limb(0, 0, -10, 2, 4, col('#4f7a3a')); ctx.fillStyle = '#b8bec6'; ctx.fillRect(-20, 0, 10, 2.4);
      ctx.restore();
    } else if (e.type === 'orc') {
      const b = Math.abs(Math.sin(walk)) * 2.5;
      limb(6, -22, 6 + ls * 9, -1, 9, col('#2e3526')); limb(-6, -22, -6 - ls * 9, -1, 9, col('#3a4330'));
      ctx.fillStyle = col('#55634a'); ctx.beginPath(); ctx.ellipse(0, -38 - b, 19, 19, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col('#4a3424'); ctx.beginPath(); ctx.moveTo(-16, -44 - b); ctx.lineTo(16, -44 - b); ctx.lineTo(14, -24 - b); ctx.lineTo(-14, -24 - b); ctx.fill();
      ctx.fillStyle = col('#6a7a5a'); ctx.beginPath(); ctx.arc(-8, -58 - b, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#efe6cf'; ctx.beginPath(); ctx.moveTo(-15, -55 - b); ctx.lineTo(-13, -62 - b); ctx.lineTo(-11, -55 - b); ctx.fill();
      ctx.fillStyle = '#ff4a2a'; ctx.fillRect(-15, -61 - b, 3, 2);
      const aa = wind ? -2.2 * wind : strike ? 1.3 : 0.2;
      ctx.save(); ctx.translate(-12, -44 - b); ctx.rotate(aa);
      limb(0, 0, -14, 6, 7, col('#55634a'));
      ctx.strokeStyle = '#3a2618'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-14, 6); ctx.lineTo(-14, -26); ctx.stroke();
      ctx.fillStyle = col('#9aa2ac'); ctx.beginPath(); ctx.moveTo(-14, -26); ctx.quadraticCurveTo(-32, -24, -28, -8); ctx.lineTo(-14, -14); ctx.fill();
      ctx.restore();
    } else if (e.type === 'archer') {
      const b = Math.abs(Math.sin(walk)) * 1.5;
      const bone = col('#d8d2c0');
      limb(3, -22, 3 + ls * 7, -1, 3, bone); limb(-3, -22, -3 - ls * 7, -1, 3, bone);
      ctx.strokeStyle = bone; ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-6, -27 - i * 4 - b); ctx.lineTo(6, -27 - i * 4 - b); ctx.stroke(); }
      limb(0, -22 - b, 0, -42 - b, 3, bone);
      ctx.fillStyle = col('#2a2230'); ctx.beginPath(); ctx.moveTo(-8, -42 - b); ctx.lineTo(8, -42 - b); ctx.lineTo(5, -26 - b); ctx.lineTo(-5, -26 - b); ctx.fill();
      ctx.fillStyle = bone; ctx.beginPath(); ctx.arc(-2, -48 - b, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1018'; ctx.fillRect(-7, -50 - b, 3, 3);
      ctx.fillStyle = '#7affd0'; ctx.globalAlpha = 0.8; ctx.fillRect(-7, -49.5 - b, 1.6, 1.6); ctx.globalAlpha = 1;
      ctx.strokeStyle = col('#6a4a2a'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(-6, -36 - b, 13, Math.PI * 0.6, Math.PI * 1.4); ctx.stroke();
      ctx.strokeStyle = 'rgba(230,230,230,.7)'; ctx.lineWidth = 0.8;
      const pull = wind * 8;
      ctx.beginPath(); ctx.moveTo(-10, -48 - b); ctx.lineTo(-6 + pull, -36 - b); ctx.lineTo(-10, -24 - b); ctx.stroke();
    } else if (e.type === 'bat') {
      const f = Math.sin(e.t * 18);
      ctx.fillStyle = col('#3a1a3a');
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(18, -6 - f * 12); ctx.lineTo(12, 2); ctx.lineTo(6, 0); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-14, -4 - f * 10); ctx.lineTo(-10, 2); ctx.fill();
      ctx.fillStyle = col('#2a0f2a'); ctx.beginPath(); ctx.ellipse(0, 0, 7, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff3a3a'; ctx.fillRect(-5, -2, 2, 2); ctx.fillRect(-1, -2, 2, 2);
    } else if (e.type === 'boss') {
      const b = Math.abs(Math.sin(walk)) * 3;
      limb(14, -40, 14 + ls * 14, -2, 18, col('#2a2028')); limb(-14, -40, -14 - ls * 14, -2, 18, col('#352a33'));
      const bg = ctx.createLinearGradient(-36, 0, 36, 0); bg.addColorStop(0, col('#4a3a44')); bg.addColorStop(1, col('#241a22'));
      ctx.fillStyle = bg; ctx.beginPath(); ctx.ellipse(0, -66 - b, 36, 32, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col('#2a2228'); ctx.beginPath(); ctx.moveTo(-30, -78 - b); ctx.lineTo(30, -78 - b); ctx.lineTo(26, -46 - b); ctx.lineTo(-26, -46 - b); ctx.fill();
      ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = col('#3a2e36'); ctx.beginPath(); ctx.arc(-12, -98 - b, 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col('#1a1418');
      ctx.beginPath(); ctx.moveTo(-4, -110 - b); ctx.quadraticCurveTo(6, -130 - b, 20, -128 - b); ctx.quadraticCurveTo(8, -122 - b, 2, -104 - b); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-22, -110 - b); ctx.quadraticCurveTo(-34, -128 - b, -44, -126 - b); ctx.quadraticCurveTo(-34, -118 - b, -26, -104 - b); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,60,40,.9)'; ctx.fillRect(-26, -101 - b, 6, 3); ctx.fillRect(-16, -101 - b, 6, 3);
      ctx.globalCompositeOperation = 'source-over';
      const aa = wind ? -2.4 * wind : strike ? 1.4 : 0.25;
      ctx.save(); ctx.translate(-28, -78 - b); ctx.rotate(aa);
      limb(0, 0, -24, 12, 14, col('#4a3a44'));
      ctx.fillStyle = col('#3a2618'); ctx.beginPath(); ctx.moveTo(-24, 14); ctx.lineTo(-30, -40); ctx.lineTo(-18, -44); ctx.lineTo(-18, 12); ctx.fill();
      ctx.fillStyle = '#7a7a82'; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-30, -20 - i * 9); ctx.lineTo(-36, -24 - i * 9); ctx.lineTo(-29, -26 - i * 9); ctx.fill(); }
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // barra vita
    if (e.hp < e.maxHp && e.type !== 'boss') {
      const w = Math.max(24, d.w), y = e.y - d.h - 12;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - w / 2, y, w, 4);
      ctx.fillStyle = '#d23a3a'; ctx.fillRect(x - w / 2, y, w * Math.max(0, e.hp / e.maxHp), 4);
    }
    if (e.state === 'windup' && e.type === 'boss') { ctx.globalAlpha = 0.5 + Math.sin(time * 30) * 0.3; text('!', x, e.y - d.h - 22, 22, '#ff5a3a'); ctx.globalAlpha = 1; }
  }

  function drawArrows() {
    ctx.strokeStyle = '#d8c8a8'; ctx.lineWidth = 1.5;
    for (const a of arrows) {
      const x = a.x - camX, ang = Math.atan2(a.vy, a.vx);
      ctx.save(); ctx.translate(x, a.y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(4, 0); ctx.stroke();
      ctx.fillStyle = '#9aa2ac'; ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(2, -2); ctx.lineTo(2, 2); ctx.fill();
      ctx.restore();
    }
  }

  // ---------- HUD ----------
  function bar(x, y, w, h, v, color, label) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; roundRect(x - 1, y - 1, w + 2, h + 2, 3); ctx.fill();
    ctx.fillStyle = color; roundRect(x, y, Math.max(0, w * v), h, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(x, y, Math.max(0, w * v), h / 2);
    if (label) text(label, x + 4, y + h / 2 + 0.5, 9, '#fff', 'left', '700', 'system-ui, sans-serif');
  }
  function drawHUD() {
    const l = safeL + 14;
    bar(l, 12, 150, 11, castle.hp / castle.max, '#b8894a', 'MURA ' + Math.ceil(castle.hp));
    bar(l, 28, 150, 11, knight.hp / knight.maxHp, '#c4303a', knightAlive() ? 'CAVALIERE ' + Math.ceil(knight.hp) : 'RITORNA TRA ' + Math.ceil(knight.deadT));
    shadowText('Ondata ' + wave, W / 2, 20, 17, '#f2e2c8');
    text(String(score), W / 2, 40, 12, '#c9b8a0', 'center', '600', 'system-ui, sans-serif');
    const pb = PAUSE_BTN();
    ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f2e2c8'; ctx.fillRect(pb.x - 6, pb.y - 7, 4, 14); ctx.fillRect(pb.x + 2, pb.y - 7, 4, 14);
    const boss = enemies.find(e => e.type === 'boss');
    if (boss) {
      shadowText('Il Signore delle Ossa', W / 2, 60, 12, '#ffb38a');
      bar(W / 2 - 120, 68, 240, 8, boss.hp / boss.maxHp, '#8a1a3a');
    }
    // nemici fuori schermo a destra
    const off = enemies.filter(e => e.x > camX + W + 4).length + spawnQueue.filter(s => s.t - waveClock < 3).length;
    if (off > 0) {
      const y = GROUND - 60, x = W - safeR - 18;
      ctx.fillStyle = 'rgba(200,40,40,.85)'; ctx.beginPath(); ctx.moveTo(x + 10, y); ctx.lineTo(x - 4, y - 10); ctx.lineTo(x - 4, y + 10); ctx.fill();
      text(String(off), x - 16, y, 12, '#ffd0c0', 'right', '700', 'system-ui, sans-serif');
    }
    // mura sotto attacco fuori schermo
    if (wallAlert > 0 && camX > 40) {
      ctx.globalAlpha = 0.6 + Math.sin(time * 12) * 0.4;
      ctx.fillStyle = '#ff5a3a'; ctx.beginPath(); ctx.moveTo(l, GROUND - 60); ctx.lineTo(l + 14, GROUND - 70); ctx.lineTo(l + 14, GROUND - 50); ctx.fill();
      text('Le mura!', l + 20, GROUND - 60, 13, '#ffb38a', 'left');
      ctx.globalAlpha = 1;
    }
    if (banner > 0) {
      ctx.globalAlpha = Math.min(1, banner);
      shadowText(wave % 5 === 0 ? 'Arriva il Signore delle Ossa' : 'Ondata ' + wave, W / 2, H * 0.36, 30, wave % 5 === 0 ? '#ff8a5a' : '#f2e2c8');
      ctx.globalAlpha = 1;
    }
  }
  function drawControls() {
    const b = buttons();
    const disc = (q, on, a) => {
      ctx.fillStyle = on ? 'rgba(255,220,180,.32)' : 'rgba(20,10,14,' + (a || 0.38) + ')';
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,180,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    };
    disc(b.left, input.left); disc(b.right, input.right);
    ctx.fillStyle = 'rgba(255,235,210,.85)';
    ctx.beginPath(); ctx.moveTo(b.left.x - 11, b.left.y); ctx.lineTo(b.left.x + 8, b.left.y - 12); ctx.lineTo(b.left.x + 8, b.left.y + 12); ctx.fill();
    ctx.beginPath(); ctx.moveTo(b.right.x + 11, b.right.y); ctx.lineTo(b.right.x - 8, b.right.y - 12); ctx.lineTo(b.right.x - 8, b.right.y + 12); ctx.fill();
    disc(b.attack, input.attack);
    ctx.save(); ctx.translate(b.attack.x, b.attack.y); ctx.rotate(-0.8);
    ctx.fillStyle = 'rgba(255,235,210,.9)'; ctx.fillRect(-2, -18, 4, 26); ctx.fillRect(-8, 6, 16, 3); ctx.fillRect(-1.5, 9, 3, 7);
    ctx.restore();
    disc(b.block, input.block);
    ctx.fillStyle = 'rgba(255,235,210,.85)';
    ctx.beginPath(); ctx.moveTo(b.block.x - 10, b.block.y - 11); ctx.lineTo(b.block.x + 10, b.block.y - 11); ctx.lineTo(b.block.x + 10, b.block.y + 1); ctx.quadraticCurveTo(b.block.x + 8, b.block.y + 10, b.block.x, b.block.y + 14); ctx.quadraticCurveTo(b.block.x - 8, b.block.y + 10, b.block.x - 10, b.block.y + 1); ctx.fill();
    // furia
    const full = knight.fury >= 100;
    disc(b.special, false, full ? 0.6 : 0.3);
    ctx.strokeStyle = full ? '#ff7a2a' : 'rgba(255,140,60,.7)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(b.special.x, b.special.y, b.special.r - 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * knight.fury / 100); ctx.stroke();
    if (full) { ctx.globalAlpha = 0.6 + Math.sin(time * 8) * 0.4; }
    text('FURIA', b.special.x, b.special.y + 1, 10, full ? '#ffd0a0' : 'rgba(255,220,190,.6)', 'center', '800', 'system-ui, sans-serif');
    ctx.globalAlpha = 1;
  }

  function overlay(a) { ctx.fillStyle = 'rgba(8,4,8,' + a + ')'; ctx.fillRect(0, 0, W, H); }
  function button(r, label, primary) {
    ctx.fillStyle = primary ? '#c9a050' : 'rgba(255,255,255,.1)';
    roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
    text(label, r.x + r.w / 2, r.y + r.h / 2 + 1, 17, primary ? '#1a0e0a' : '#f2e2c8');
  }

  function drawWorld() {
    if (ART.background) {
      // sfondo dipinto ripetuto in orizzontale con parallasse
      const img = ART.background, h = GROUND + 30, w = img.width * h / img.height;
      const off = (camX * 0.3) % w;
      for (let x = -off; x < W; x += w) ctx.drawImage(img, x, 0, w + 1, h);
    } else {
      drawSky();
      layer(0.12, 230, 70, 70, '#26162e', 1);
      layer(0.3, 262, 45, 50, '#1c1222', 7);
      drawTrees(0.3, '#160d1a');
    }
    layer(0.55, 285, 22, 40, 'rgba(25,16,22,.85)', 13);
    drawGround();
    drawCastle();
  }

  function render() {
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    if (portrait) {
      ctx.fillStyle = '#0d0a10'; ctx.fillRect(0, 0, W, H);
      shadowText('Ruota il telefono', W / 2, H / 2 - 10, 24, '#f2e2c8');
      text('Il gioco si gioca in orizzontale', W / 2, H / 2 + 20, 13, '#a89a8a', 'center', '500', 'system-ui, sans-serif');
      return;
    }
    if (state === 'menu') {
      camX = (Math.sin(time * 0.05) * 0.5 + 0.5) * (WORLD_W - W) * 0.3;
      drawWorld();
      overlay(0.35);
      shadowText('LAST LINE', W / 2, H * 0.3, 56, '#e8c88a', 'center', '800');
      text('Difendi le mura dalle orde della notte', W / 2, H * 0.3 + 40, 15, '#d8c4b0', 'center', '500');
      if (best > 0) text('Record: ' + best + '  ·  Ondata massima: ' + bestWave, W / 2, H * 0.55, 13, '#c9b8a0', 'center', '600', 'system-ui, sans-serif');
      ctx.globalAlpha = 0.6 + Math.sin(time * 4) * 0.4;
      shadowText('Tocca per iniziare', W / 2, H * 0.66, 20, '#ffffff');
      ctx.globalAlpha = 1;
      button(MUTE_BTN(), muted ? 'Audio: no' : 'Audio: sì', false);
      return;
    }

    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake) * 0.4, rand(-shake, shake) * 0.4);
    drawWorld();
    for (const e of enemies) if (!e.d.flying) drawEnemy(e);
    drawKnight();
    for (const e of enemies) if (e.d.flying) drawEnemy(e);
    drawArrows();
    for (const q of particles) { ctx.globalAlpha = Math.max(0, q.life / q.max); ctx.fillStyle = q.color; ctx.fillRect(q.x - camX - q.size / 2, q.y - q.size / 2, q.size, q.size); }
    ctx.globalAlpha = 1;
    for (const f of floaters) { ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5)); shadowText(f.text, f.x - camX, f.y, f.size, f.color); }
    ctx.globalAlpha = 1;
    // vignettatura
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.5)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    ctx.restore();

    drawHUD();
    if (state === 'play') drawControls();

    if (state === 'pause') {
      overlay(0.65);
      shadowText('Pausa', W / 2, H / 2 - 60, 34, '#f2e2c8');
      const [r, m] = pauseButtons(); button(r, r.label, true); button(m, m.label, false);
    } else if (state === 'upgrade') {
      overlay(0.7);
      shadowText('Ondata ' + wave + ' respinta', W / 2, H / 2 - 92, 26, '#e8c88a');
      text('Scegli una benedizione', W / 2, H / 2 - 62, 14, '#c9b8a0', 'center', '500', 'system-ui, sans-serif');
      ctx.globalAlpha = stateTime >= 0.6 ? 1 : 0.5;
      upgradeChoices.forEach((u, i) => {
        const r = cardRect(i);
        const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h); g.addColorStop(0, '#2a1a20'); g.addColorStop(1, '#160c10');
        ctx.fillStyle = g; roundRect(r.x, r.y, r.w, r.h, 10); ctx.fill();
        ctx.strokeStyle = '#c9a050'; ctx.lineWidth = 1.5; roundRect(r.x, r.y, r.w, r.h, 10); ctx.stroke();
        text(u.name, r.x + r.w / 2, r.y + 46, 16, '#f2e2c8');
        text(u.desc, r.x + r.w / 2, r.y + 80, 12, '#c9b8a0', 'center', '500', 'system-ui, sans-serif');
        text(String(i + 1), r.x + r.w / 2, r.y + 112, 11, 'rgba(201,160,80,.6)', 'center', '700', 'system-ui, sans-serif');
      });
      ctx.globalAlpha = 1;
    } else if (state === 'over') {
      overlay(Math.min(0.8, stateTime));
      shadowText('Le mura sono cadute', W / 2, H * 0.3, 34, '#ff7a5a');
      shadowText(String(score), W / 2, H * 0.45, 40, '#ffffff');
      text('Ondata raggiunta: ' + wave + '   ·   Record: ' + best + '   ·   Ondata massima: ' + bestWave, W / 2, H * 0.56, 13, '#c9b8a0', 'center', '500', 'system-ui, sans-serif');
      if (stateTime > 1) { ctx.globalAlpha = 0.6 + Math.sin(time * 4) * 0.4; shadowText('Tocca per riprovare', W / 2, H * 0.7, 18, '#e8c88a'); ctx.globalAlpha = 1; }
    }
  }

  // ---------- Loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
    last = now; time += dt;
    update(dt); render();
    requestAnimationFrame(frame);
  }
  resize();
  requestAnimationFrame(frame);

  // hook per i test automatici
  window.__game = {
    get state() { return state; }, get wave() { return wave; }, get score() { return score; },
    get knight() { return knight; }, get castle() { return castle; }, get enemies() { return enemies; },
    jump(n) { wave = n - 1; enemies = []; spawnQueue = []; arrows = []; startWave(); setState('play'); }
  };
})();
