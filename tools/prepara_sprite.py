#!/usr/bin/env python3
"""Prepara un'immagine generata per il gioco.

Uso:  python3 tools/prepara_sprite.py immagine.png nome [--flip] [--alto 512] [--tolleranza 60]

- toglie lo sfondo se è di un colore uniforme (lo legge dagli angoli; se l'immagine è già trasparente la lascia così)
- ritaglia lo spazio vuoto intorno al personaggio
- --flip lo specchia se è rivolto a sinistra (nel gioco tutti gli sprite guardano a destra)
- ridimensiona all'altezza indicata e salva in www/assets/<nome>.png
- aggiunge <nome> a www/assets/art.js
Per sfondo e castello usa --sfondo: niente rimozione dello sfondo, solo ridimensionamento.
"""
import argparse, os, re
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'www', 'assets')


def remove_background(img, tol):
    px = img.load()
    w, h = img.size
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    if all(c[3] < 10 for c in corners):
        return img  # già trasparente
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    out = img.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = op[x, y]
            d = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
            if d < tol:
                op[x, y] = (r, g, b, 0)
            elif d < tol * 2:  # bordo morbido
                op[x, y] = (r, g, b, int(a * (d - tol) / tol))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('name')
    ap.add_argument('--flip', action='store_true')
    ap.add_argument('--sfondo', action='store_true')
    ap.add_argument('--alto', type=int, default=512)
    ap.add_argument('--tolleranza', type=int, default=60)
    a = ap.parse_args()
    img = Image.open(a.src).convert('RGBA')
    if not a.sfondo:
        img = remove_background(img, a.tolleranza)
        bbox = img.getchannel('A').point(lambda v: 255 if v > 20 else 0).getbbox()
        if bbox:
            img = img.crop(bbox)
    if a.flip:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    alto = a.alto if not a.sfondo else max(a.alto, 720)
    if img.height > alto:
        img = img.resize((round(img.width * alto / img.height), alto), Image.LANCZOS)
    os.makedirs(ASSETS, exist_ok=True)
    dst = os.path.join(ASSETS, a.name + '.png')
    img.save(dst, optimize=True)
    js = os.path.join(ASSETS, 'art.js')
    text = open(js).read()
    names = re.search(r'ART_FILES = \[(.*?)\]', text).group(1)
    lst = [n.strip().strip("'\"") for n in names.split(',') if n.strip()]
    if a.name not in lst:
        lst.append(a.name)
    text = re.sub(r'ART_FILES = \[.*?\]', 'ART_FILES = [' + ', '.join("'%s'" % n for n in lst) + ']', text)
    open(js, 'w').write(text)
    print('salvato', dst, img.size)


if __name__ == '__main__':
    main()
