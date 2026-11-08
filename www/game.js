'use strict';
(() => {
  // ---------- Canvas & scaling ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = 400;            // larghezza logica fissa
  let H = 700, scale = 1, dpr = 1, safeTop = 0, safeBottom = 0;

  function readInset(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return parseFloat(v) || 0;
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = window.innerWidth, ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    scale = cw / W;
    H = ch / scale;
    safeTop = Math.max(8, readInset('--sat') / scale);
    safeBottom = readInset('--sab') / scale;
    if (player) player.y = playerY();
  }
  window.addEventListener('resize', resize);

  // ---------- Storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  let best = store.get('ll_best', 0);
  let bestWave = store.get('ll_bestwave', 0);
  let muted = store.get('ll_muted', false);

  // ---------- Audio (sintetizzato, nessun file) ----------
  let actx = null;
  function initAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
  }
  function tone(freq, dur, type, vol, slide) {
    if (muted || !actx) return;
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  let lastShootSfx = 0;
  const sfx = {
    shoot() { if (time - lastShootSfx < 0.09) return; lastShootSfx = time; tone(900, 0.05, 'square', 0.012, -400); },
    hit() { tone(320, 0.05, 'triangle', 0.03, -120); },
    boom() { tone(180, 0.25, 'sawtooth', 0.05, -140); },
    hurt() { tone(130, 0.4, 'sawtooth', 0.09, -90); },
    wave() { tone(523, 0.12, 'triangle', 0.06, 0); setTimeout(() => tone(784, 0.2, 'triangle', 0.06, 0), 110); },
    pick() { tone(660, 0.12, 'triangle', 0.06, 300); },
    heart() { tone(700, 0.1, 'sine', 0.07, 400); }
  };
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

  // ---------- Utils ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };

  // ---------- Stato ----------
  let state = 'menu';         // menu | play | upgrade | pause | over
  let stateTime = 0;          // secondi nello stato corrente (anti-tap accidentale)
  let time = 0;
  let player = null, bullets = [], enemies = [], ebullets = [], particles = [], floaters = [], pickups = [];
  let spawnQueue = [], waveClock = 0, wave = 0, score = 0, shake = 0, waveBanner = 0;
  let upgradeChoices = [];
  const stars = [];
  for (let i = 0; i < 90; i++) stars.push({ x: Math.random() * W, y: Math.random() * 2000, s: rand(0.4, 1.8), v: rand(15, 70) });

  function playerY() { return H - 95 - safeBottom; }
  function setState(s) { state = s; stateTime = 0; }

  function newGame() {
    player = { x: W / 2, tx: W / 2, y: playerY(), r: 13, hp: 3, maxHp: 3, inv: 0, fireCd: 0,
      dmg: 1, rate: 4, shots: 1, bspeed: 650, pierce: 0, crit: 0, tilt: 0 };
    bullets = []; enemies = []; ebullets = []; particles = []; floaters = []; pickups = [];
    wave = 0; score = 0; shake = 0;
    startWave();
    setState('play');
  }

  function startWave() {
    wave++;
    spawnQueue = buildWave(wave);
    waveClock = 0;
    waveBanner = 2.2;
  }

  // ---------- Nemici ----------
  const DEFS = {
    basic:   { r: 16, hp: 3,   vy: 70,  score: 10,  color: '#ff4d6d' },
    zig:     { r: 14, hp: 2,   vy: 85,  score: 15,  color: '#ffd166' },
    tank:    { r: 26, hp: 12,  vy: 38,  score: 40,  color: '#9b5de5' },
    shooter: { r: 18, hp: 5,   vy: 55,  score: 30,  color: '#00f5d4' },
    swarm:   { r: 10, hp: 1,   vy: 150, score: 5,   color: '#f15bb5' },
    boss:    { r: 50, hp: 110, vy: 60,  score: 500, color: '#ff8c1a' }
  };

  function pickType(n) {
    const w = [
      ['basic', 10],
      ['zig', n >= 2 ? 6 : 0],
      ['tank', n >= 3 ? 2 + n * 0.25 : 0],
      ['shooter', n >= 4 ? 2 + n * 0.25 : 0],
      ['swarm', n >= 6 ? 2.5 : 0]
    ];
    let tot = 0; for (const [, v] of w) tot += v;
    let r = Math.random() * tot;
    for (const [k, v] of w) { if ((r -= v) <= 0) return k; }
    return 'basic';
  }

  function buildWave(n) {
    const q = [];
    const hpMul = 1 + (n - 1) * 0.22;
    let t = 1.5;
    if (n % 5 === 0) {
      q.push({ t, type: 'boss', hpMul: 1 + (n / 5 - 1) * 0.8 });
      for (let i = 0; i < 2 + Math.floor(n / 3); i++) { t += 2.5; q.push({ t, type: 'basic', hpMul }); }
      return q;
    }
    const count = Math.round(6 + n * 2.4);
    const gap = Math.max(0.28, 1.0 - n * 0.045);
    for (let i = 0; i < count; i++) {
      const type = pickType(n);
      if (type === 'swarm') {
        const cx = rand(70, W - 70);
        for (let k = 0; k < 5; k++) q.push({ t: t + Math.abs(k - 2) * 0.12, type, hpMul, x: cx + (k - 2) * 26 });
        t += gap * 2;
      } else {
        q.push({ t, type, hpMul });
        t += gap * rand(0.6, 1.4);
      }
    }
    return q;
  }

  function spawn(e) {
    const d = DEFS[e.type];
    const speedMul = 1 + Math.min(0.6, (wave - 1) * 0.03);
    const x = e.x !== undefined ? e.x : rand(d.r + 10, W - d.r - 10);
    const hp = Math.ceil(d.hp * e.hpMul);
    enemies.push({
      type: e.type, x, baseX: x, y: -d.r - 5, r: d.r, hp, maxHp: hp, vy: d.vy * speedMul,
      vx: Math.random() < 0.5 ? -50 : 50, color: d.color, score: d.score, t: Math.random() * 6,
      flash: 0, shootT: rand(0.8, 1.8), stopY: rand(H * 0.18, H * 0.38), hover: 0, phase: 0
    });
  }

  function enemyShoot(e, angle, speed) {
    ebullets.push({ x: e.x, y: e.y + e.r * 0.6, vx: Math.sin(angle) * speed, vy: Math.cos(angle) * speed, r: 5 });
  }

  function updateEnemy(e, dt) {
    e.t += dt;
    if (e.flash > 0) e.flash -= dt;
    switch (e.type) {
      case 'zig':
        e.y += e.vy * dt;
        e.x = clamp(e.baseX + Math.sin(e.t * 2.8) * 60, e.r, W - e.r);
        break;
      case 'shooter':
        if (e.phase === 0) { e.y += e.vy * dt; if (e.y >= e.stopY) e.phase = 1; }
        else if (e.phase === 1) {
          e.hover += dt;
          e.x += e.vx * dt;
          if (e.x < e.r || e.x > W - e.r) { e.vx *= -1; e.x = clamp(e.x, e.r, W - e.r); }
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = Math.max(0.9, 1.8 - wave * 0.03);
            const a = Math.atan2(player.x - e.x, player.y - e.y);
            enemyShoot(e, a, 200);
          }
          if (e.hover > 7) e.phase = 2;
        } else e.y += e.vy * 1.3 * dt;
        break;
      case 'boss': {
        const stopY = 150 + safeTop;
        if (e.y < stopY) { e.y += e.vy * dt; break; }
        const enraged = e.hp < e.maxHp * 0.5;
        e.x += e.vx * (enraged ? 2.2 : 1.4) * dt;
        if (e.x < e.r + 5 || e.x > W - e.r - 5) { e.vx *= -1; e.x = clamp(e.x, e.r + 5, W - e.r - 5); }
        e.shootT -= dt;
        if (e.shootT <= 0) {
          e.phase = (e.phase + 1) % 3;
          e.shootT = enraged ? 1.1 : 1.6;
          if (e.phase === 0) { // ventaglio
            const n = enraged ? 9 : 7;
            for (let i = 0; i < n; i++) enemyShoot(e, (i - (n - 1) / 2) * 0.16, 170);
          } else if (e.phase === 1) { // mirato a raffica
            const a = Math.atan2(player.x - e.x, player.y - e.y);
            for (let i = 0; i < 3; i++) setTimeoutGame(() => { if (e.hp > 0) enemyShoot(e, a, 240); }, i * 0.15);
          } else { // pioggia
            for (let i = 0; i < 4; i++) enemyShoot(e, rand(-0.5, 0.5), rand(140, 200));
          }
        }
        break;
      }
      default:
        e.y += e.vy * dt;
    }
  }

  // timer interni al gioco (si fermano in pausa)
  let timers = [];
  function setTimeoutGame(fn, delay) { timers.push({ t: delay, fn }); }

  // ---------- Effetti ----------
  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(speed * 0.3, speed);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), max: 0.7, color, size: rand(1.5, 3.5) });
    }
  }
  function floater(x, y, text, color) { floaters.push({ x, y, text, color, life: 0.8 }); }

  function killEnemy(e) {
    score += e.score;
    burst(e.x, e.y, e.color, e.type === 'boss' ? 80 : 16, e.type === 'boss' ? 320 : 180);
    shake = Math.max(shake, e.type === 'boss' ? 14 : e.type === 'tank' ? 5 : 2);
    sfx.boom();
    if (e.type === 'boss') { vibrate(150); ebullets = []; }
    if (e.type !== 'swarm' && player.hp < player.maxHp && Math.random() < 0.04) {
      pickups.push({ x: e.x, y: e.y, vy: 90, r: 10 });
    }
  }

  function hurtPlayer() {
    if (player.inv > 0) return;
    player.hp--;
    player.inv = 1.3;
    shake = 12;
    sfx.hurt();
    vibrate(80);
    burst(player.x, player.y, '#4cc9f0', 20, 200);
    if (player.hp <= 0) {
      burst(player.x, player.y, '#ffffff', 60, 300);
      if (score > best) { best = score; store.set('ll_best', best); }
      if (wave > bestWave) { bestWave = wave; store.set('ll_bestwave', bestWave); }
      drag = null;
      setState('over');
    }
  }

  // ---------- Upgrade ----------
  const UPGRADES = [
    { name: 'Potenza', desc: '+30% danno', apply: p => { p.dmg *= 1.3; } },
    { name: 'Raffica', desc: '+20% cadenza di fuoco', apply: p => { p.rate *= 1.2; }, ok: p => p.rate < 14 },
    { name: 'Multicolpo', desc: '+1 proiettile', apply: p => { p.shots++; }, ok: p => p.shots < 6 },
    { name: 'Perforante', desc: 'Attraversa +1 nemico', apply: p => { p.pierce++; }, ok: p => p.pierce < 4 },
    { name: 'Critico', desc: '+10% probabilità danno x2', apply: p => { p.crit += 0.1; }, ok: p => p.crit < 0.55 },
    { name: 'Corazza', desc: '+1 vita massima', apply: p => { p.maxHp++; p.hp++; }, ok: p => p.maxHp < 8 },
    { name: 'Riparazione', desc: 'Vita al massimo', apply: p => { p.hp = p.maxHp; }, ok: p => p.hp < p.maxHp },
    { name: 'Velocità colpi', desc: '+20% velocità proiettili', apply: p => { p.bspeed *= 1.2; }, ok: p => p.bspeed < 1300 }
  ];
  function rollUpgrades() {
    const pool = UPGRADES.filter(u => !u.ok || u.ok(player));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    upgradeChoices = pool.slice(0, 3);
  }
  function upgradeCardRect(i) {
    const w = W - 60, h = 92, gap = 16;
    const total = 3 * h + 2 * gap;
    return { x: 30, y: H / 2 - total / 2 + 20 + i * (h + gap), w, h };
  }

  // ---------- Input ----------
  let drag = null;
  const keys = {};
  const SENS = 1.25;
  const PAUSE_BTN = () => ({ x: W - 34, y: safeTop + 26, r: 20 });

  function toLogical(e) { return { x: e.clientX / scale, y: e.clientY / scale }; }
  function inRect(p, r) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }

  canvas.addEventListener('pointerdown', e => {
    initAudio();
    const p = toLogical(e);
    if (state === 'play') {
      const b = PAUSE_BTN();
      if (dist2(p.x, p.y, b.x, b.y) < (b.r + 10) * (b.r + 10)) { pause(); return; }
      drag = { id: e.pointerId, lastX: e.clientX };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      return;
    }
    handleTap(p);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId || state !== 'play') return;
    player.tx += (e.clientX - drag.lastX) / scale * SENS;
    player.tx = clamp(player.tx, player.r, W - player.r);
    drag.lastX = e.clientX;
  });
  const endDrag = e => { if (drag && drag.id === e.pointerId) drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  window.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (e.key === 'Escape' || e.key === 'p') { if (state === 'play') pause(); else if (state === 'pause') resume(); }
    if ((e.key === 'Enter' || e.key === ' ') && (state === 'menu' || state === 'over')) { initAudio(); newGame(); }
    if (state === 'upgrade' && stateTime > 0.6 && ['1', '2', '3'].includes(e.key)) chooseUpgrade(+e.key - 1);
  });
  window.addEventListener('keyup', e => { keys[e.key] = false; });

  function pause() { if (state !== 'play') return; drag = null; setState('pause'); }
  function resume() { setState('play'); }

  const MUTE_BTN = () => ({ x: W / 2 - 70, y: H - 110 - safeBottom, w: 140, h: 40 });
  function pauseButtons() {
    return [
      { label: 'Riprendi', act: resume, x: W / 2 - 90, y: H / 2 - 10, w: 180, h: 50 },
      { label: 'Menu', act: () => setState('menu'), x: W / 2 - 90, y: H / 2 + 56, w: 180, h: 50 }
    ];
  }

  function chooseUpgrade(i) {
    const u = upgradeChoices[i];
    if (!u) return;
    u.apply(player);
    sfx.pick();
    startWave();
    setState('play');
  }

  function handleTap(p) {
    if (state === 'menu') {
      if (inRect(p, MUTE_BTN())) { muted = !muted; store.set('ll_muted', muted); return; }
      newGame();
    } else if (state === 'over') {
      if (stateTime > 0.9) newGame();
    } else if (state === 'pause') {
      for (const b of pauseButtons()) if (inRect(p, b)) { b.act(); return; }
    } else if (state === 'upgrade') {
      if (stateTime < 0.6) return;   // evita la scelta involontaria mentre si stava trascinando
      for (let i = 0; i < upgradeChoices.length; i++) if (inRect(p, upgradeCardRect(i))) { chooseUpgrade(i); return; }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pause();
      if (actx && actx.state === 'running') actx.suspend();
    }
  });

  // Tasto "indietro" di Android (Capacitor App plugin, se presente)
  try {
    const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (AppPlugin) {
      AppPlugin.addListener('backButton', () => {
        if (state === 'play') pause();
        else if (state === 'pause') resume();
        else if (state === 'over') setState('menu');
        else if (state === 'menu') AppPlugin.exitApp();
      });
      AppPlugin.addListener('pause', () => pause());
    }
  } catch (e) { /* non in app nativa */ }

  // ---------- Update ----------
  function update(dt) {
    stateTime += dt;
    for (const s of stars) { s.y += s.v * dt * (state === 'play' ? 1.6 : 1); if (s.y > H) { s.y -= H + 10; s.x = Math.random() * W; } }

    if (state === 'pause') return;

    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.96; q.vy *= 0.96; q.life -= dt;
      if (q.life <= 0) particles.splice(i, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; f.y -= 40 * dt; f.life -= dt; if (f.life <= 0) floaters.splice(i, 1);
    }
    shake = Math.max(0, shake - 40 * dt);
    if (state !== 'play') return;

    // timers
    for (let i = timers.length - 1; i >= 0; i--) { timers[i].t -= dt; if (timers[i].t <= 0) { const fn = timers[i].fn; timers.splice(i, 1); fn(); } }

    // player movement
    let kdir = 0;
    if (keys.ArrowLeft || keys.a) kdir -= 1;
    if (keys.ArrowRight || keys.d) kdir += 1;
    if (kdir) player.tx = clamp(player.tx + kdir * 430 * dt, player.r, W - player.r);
    const prevX = player.x;
    const maxStep = 1500 * dt;
    player.x += clamp(player.tx - player.x, -maxStep, maxStep);
    player.y = playerY();
    player.tilt += ((player.x - prevX) / Math.max(dt, 0.001) / 900 - player.tilt) * Math.min(1, dt * 12);
    if (player.inv > 0) player.inv -= dt;
    if (waveBanner > 0) waveBanner -= dt;

    // fire
    player.fireCd -= dt;
    if (player.fireCd <= 0) {
      player.fireCd += 1 / player.rate;
      if (player.fireCd < 0) player.fireCd = 0;
      const n = player.shots, spread = 0.11;
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * spread;
        bullets.push({ x: player.x + (i - (n - 1) / 2) * 5, y: player.y - 16, vx: Math.sin(a) * player.bspeed,
          vy: -Math.cos(a) * player.bspeed, pierce: player.pierce, hit: [] });
      }
      sfx.shoot();
    }

    // spawn
    waveClock += dt;
    while (spawnQueue.length && spawnQueue[0].t <= waveClock) spawn(spawnQueue.shift());

    // bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.y < -20 || b.x < -20 || b.x > W + 20) { bullets.splice(i, 1); continue; }
      for (const e of enemies) {
        if (e.hp <= 0 || b.hit.includes(e)) continue;
        const rr = e.r + 4;
        if (dist2(b.x, b.y, e.x, e.y) < rr * rr) {
          const isCrit = Math.random() < player.crit;
          const dmg = player.dmg * (isCrit ? 2 : 1);
          e.hp -= dmg; e.flash = 0.08;
          if (isCrit) floater(e.x, e.y - e.r, 'CRIT', '#ffd166');
          burst(b.x, b.y, '#bdf6ff', 3, 90);
          sfx.hit();
          b.hit.push(e);
          if (b.pierce > 0) b.pierce--; else { bullets.splice(i, 1); break; }
        }
      }
    }

    // enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.hp <= 0) { killEnemy(e); enemies.splice(i, 1); continue; }
      updateEnemy(e, dt);
      const rr = e.r + player.r - 4;
      if (dist2(e.x, e.y, player.x, player.y) < rr * rr) {
        hurtPlayer();
        if (e.type !== 'boss') { burst(e.x, e.y, e.color, 14, 160); enemies.splice(i, 1); continue; }
      }
      if (e.y - e.r > H) {
        enemies.splice(i, 1);
        floater(clamp(e.x, 30, W - 30), H - 30, '-1', '#ff4d6d');
        hurtPlayer();
      }
      if (state !== 'play') return;
    }

    // enemy bullets
    for (let i = ebullets.length - 1; i >= 0; i--) {
      const b = ebullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.y > H + 20 || b.y < -40 || b.x < -20 || b.x > W + 20) { ebullets.splice(i, 1); continue; }
      const rr = b.r + player.r - 5;
      if (dist2(b.x, b.y, player.x, player.y) < rr * rr) { ebullets.splice(i, 1); hurtPlayer(); if (state !== 'play') return; }
    }

    // pickups (cuori)
    for (let i = pickups.length - 1; i >= 0; i--) {
      const k = pickups[i];
      k.y += k.vy * dt;
      if (k.y > H + 20) { pickups.splice(i, 1); continue; }
      const rr = k.r + player.r + 4;
      if (dist2(k.x, k.y, player.x, player.y) < rr * rr) {
        pickups.splice(i, 1);
        player.hp = Math.min(player.maxHp, player.hp + 1);
        floater(player.x, player.y - 30, '+1', '#ff6b9a');
        sfx.heart();
      }
    }

    // fine ondata
    if (!spawnQueue.length && !enemies.length) {
      ebullets = []; timers = []; drag = null;
      score += wave * 25;
      sfx.wave();
      rollUpgrades();
      setState('upgrade');
    }
  }

  // ---------- Render ----------
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function poly(x, y, r, n, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const a = rot + i * Math.PI * 2 / n; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath();
  }
  function text(str, x, y, size, color, align, weight) {
    ctx.font = (weight || '700') + ' ' + size + 'px system-ui, -apple-system, Roboto, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function heart(x, y, s, filled) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.35);
    ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
    ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.75, x, y + s);
    ctx.bezierCurveTo(x, y + s * 0.75, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
    ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.35);
    ctx.closePath();
    if (filled) { ctx.fillStyle = '#ff4d6d'; ctx.fill(); }
    else { ctx.strokeStyle = '#ff4d6d88'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }

  function drawPlayer() {
    if (player.inv > 0 && Math.floor(player.inv * 12) % 2 === 0) return;
    const { x, y } = player;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(clamp(player.tilt, -1, 1) * 0.25);
    // fiamma
    ctx.fillStyle = Math.random() < 0.5 ? '#ffb703' : '#fb8500';
    ctx.beginPath(); ctx.moveTo(-6, 14); ctx.lineTo(0, 24 + Math.random() * 8); ctx.lineTo(6, 14); ctx.fill();
    // corpo
    ctx.fillStyle = '#4cc9f0';
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(16, 14); ctx.lineTo(0, 8); ctx.lineTo(-16, 14); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e0fbfc';
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(5, 4); ctx.lineTo(-5, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawEnemy(e) {
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
    const spin = e.t * 1.5;
    switch (e.type) {
      case 'basic': poly(e.x, e.y, e.r, 4, Math.PI / 4 + Math.sin(e.t * 3) * 0.2); ctx.fill(); break;
      case 'zig': poly(e.x, e.y, e.r, 3, Math.PI / 2); ctx.fill(); break;
      case 'tank': poly(e.x, e.y, e.r, 6, spin * 0.3); ctx.fill();
        ctx.fillStyle = '#0b0b1a'; poly(e.x, e.y, e.r * 0.5, 6, spin * 0.3); ctx.fill(); break;
      case 'shooter': poly(e.x, e.y, e.r, 5, spin); ctx.fill();
        ctx.fillStyle = '#0b0b1a'; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.35, 0, Math.PI * 2); ctx.fill(); break;
      case 'swarm': ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill(); break;
      case 'boss':
        poly(e.x, e.y, e.r, 8, spin * 0.2); ctx.fill();
        ctx.fillStyle = '#0b0b1a'; poly(e.x, e.y, e.r * 0.6, 8, -spin * 0.4); ctx.fill();
        ctx.fillStyle = e.hp < e.maxHp * 0.5 ? '#ff2040' : '#ffd166';
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.25, 0, Math.PI * 2); ctx.fill();
        break;
    }
    if (e.type !== 'boss' && e.type !== 'swarm' && e.hp < e.maxHp) {
      const w = e.r * 1.6;
      ctx.fillStyle = '#ffffff22'; ctx.fillRect(e.x - w / 2, e.y - e.r - 9, w, 3);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(e.x - w / 2, e.y - e.r - 9, w * Math.max(0, e.hp / e.maxHp), 3);
    }
  }

  function drawHUD() {
    const top = safeTop;
    text(String(score), 16, top + 22, 22, '#ffffff', 'left');
    text('ONDATA ' + wave, W / 2, top + 22, 15, '#a0a8d0', 'center', '600');
    for (let i = 0; i < player.maxHp; i++) heart(22 + i * 22, top + 40, 16, i < player.hp);
    // pausa
    const b = PAUSE_BTN();
    ctx.fillStyle = '#ffffff18'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(b.x - 7, b.y - 8, 5, 16); ctx.fillRect(b.x + 2, b.y - 8, 5, 16);
    // barra boss
    const boss = enemies.find(e => e.type === 'boss');
    if (boss) {
      const w = W - 80, y = top + 72;
      ctx.fillStyle = '#ffffff22'; roundRect(40, y, w, 8, 4); ctx.fill();
      ctx.fillStyle = '#ff8c1a'; roundRect(40, y, w * Math.max(0, boss.hp / boss.maxHp), 8, 4); ctx.fill();
    }
    if (waveBanner > 0) {
      ctx.globalAlpha = Math.min(1, waveBanner);
      text(wave % 5 === 0 ? 'BOSS!' : 'ONDATA ' + wave, W / 2, H * 0.38, 40, wave % 5 === 0 ? '#ff8c1a' : '#ffffff');
      ctx.globalAlpha = 1;
    }
  }

  function overlay(a) { ctx.fillStyle = 'rgba(8,8,20,' + a + ')'; ctx.fillRect(0, 0, W, H); }
  function button(b, label, primary) {
    ctx.fillStyle = primary ? '#4cc9f0' : '#ffffff18';
    roundRect(b.x, b.y, b.w, b.h, 12); ctx.fill();
    text(label, b.x + b.w / 2, b.y + b.h / 2, 18, primary ? '#0b0b1a' : '#ffffff');
  }

  function render() {
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.fillStyle = '#0b0b1a';
    ctx.fillRect(0, 0, W, H);
    for (const s of stars) { ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + s.s * 0.3) + ')'; ctx.fillRect(s.x, s.y % H, s.s, s.s); }

    if (state === 'menu') { drawMenu(); return; }

    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.5);

    // linea di difesa
    ctx.strokeStyle = '#ff4d6d33'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(0, H - 40 - safeBottom); ctx.lineTo(W, H - 40 - safeBottom); ctx.stroke(); ctx.setLineDash([]);

    for (const k of pickups) heart(k.x, k.y - 8, 18, true);
    for (const e of enemies) drawEnemy(e);
    ctx.fillStyle = '#bdf6ff';
    for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 8, 4, 14);
    ctx.fillStyle = '#ff5c8a';
    for (const b of ebullets) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
    if (state !== 'over') drawPlayer();

    ctx.globalCompositeOperation = 'lighter';
    for (const q of particles) { ctx.globalAlpha = Math.max(0, q.life / q.max); ctx.fillStyle = q.color; ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    for (const f of floaters) { ctx.globalAlpha = Math.max(0, f.life / 0.8); text(f.text, f.x, f.y, 14, f.color); }
    ctx.globalAlpha = 1;
    ctx.restore();

    drawHUD();

    if (state === 'pause') {
      overlay(0.7);
      text('PAUSA', W / 2, H / 2 - 70, 38, '#ffffff');
      const [r, m] = pauseButtons();
      button(r, r.label, true); button(m, m.label, false);
    } else if (state === 'upgrade') {
      overlay(0.75);
      text('ONDATA ' + wave + ' SUPERATA', W / 2, upgradeCardRect(0).y - 60, 24, '#ffffff');
      text('Scegli un potenziamento', W / 2, upgradeCardRect(0).y - 30, 15, '#a0a8d0', 'center', '500');
      const ready = stateTime >= 0.6;
      ctx.globalAlpha = ready ? 1 : 0.5;
      upgradeChoices.forEach((u, i) => {
        const r = upgradeCardRect(i);
        ctx.fillStyle = '#1b1d3a'; roundRect(r.x, r.y, r.w, r.h, 14); ctx.fill();
        ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 2; roundRect(r.x, r.y, r.w, r.h, 14); ctx.stroke();
        text(u.name, r.x + 20, r.y + 34, 20, '#ffffff', 'left');
        text(u.desc, r.x + 20, r.y + 62, 14, '#a0a8d0', 'left', '500');
      });
      ctx.globalAlpha = 1;
    } else if (state === 'over') {
      overlay(Math.min(0.8, stateTime));
      text('GAME OVER', W / 2, H * 0.32, 40, '#ff4d6d');
      text(String(score), W / 2, H * 0.43, 48, '#ffffff');
      text('Ondata raggiunta: ' + wave, W / 2, H * 0.50, 16, '#a0a8d0', 'center', '500');
      text('Record: ' + best + '  ·  Ondata max: ' + bestWave, W / 2, H * 0.54, 15, '#a0a8d0', 'center', '500');
      if (stateTime > 0.9) {
        ctx.globalAlpha = 0.6 + Math.sin(time * 4) * 0.4;
        text('Tocca per riprovare', W / 2, H * 0.68, 18, '#4cc9f0');
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawMenu() {
    text('LAST', W / 2, H * 0.26, 64, '#4cc9f0', 'center', '900');
    text('LINE', W / 2, H * 0.26 + 62, 64, '#ff4d6d', 'center', '900');
    text('Difendi la linea. Sopravvivi alle ondate.', W / 2, H * 0.26 + 120, 14, '#a0a8d0', 'center', '500');
    if (best > 0) text('Record: ' + best + '  ·  Ondata max: ' + bestWave, W / 2, H * 0.52, 15, '#ffffff', 'center', '600');
    ctx.globalAlpha = 0.6 + Math.sin(time * 4) * 0.4;
    text('Tocca per iniziare', W / 2, H * 0.62, 20, '#ffffff');
    ctx.globalAlpha = 1;
    text('Trascina il dito a destra e sinistra', W / 2, H * 0.70, 13, '#a0a8d0', 'center', '500');
    button(MUTE_BTN(), muted ? 'Audio: OFF' : 'Audio: ON', false);
  }

  // ---------- Loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
    last = now;
    time += dt;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  resize();
  requestAnimationFrame(frame);

  // hook per test automatici
  window.__game = { get state() { return state; }, get wave() { return wave; }, get score() { return score; }, get player() { return player; }, get enemies() { return enemies; },
    jump(n) { wave = n - 1; enemies = []; spawnQueue = []; ebullets = []; startWave(); setState('play'); } };
})();
