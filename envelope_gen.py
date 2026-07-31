#!/usr/bin/env python3
"""Генерация конверта Correos Express с адресом клиента.

Читает из stdin JSON: {"text": "строка1\nстрока2", "out": "/path/out.jpg"}
Накладывает адрес получателя на шаблон chat/envelope-template.png в область
смарт-слоя «Text Edit» (из макета MonetoPlusFinal3.psd) и сохраняет JPEG.
Печатает в stdout JSON: {"ok": true, "out": "..."}.

Верхняя строка — до 45 символов, нижняя — до 15 (как в макете).
"""
import sys
import os
import json


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(BASE_DIR, 'chat', 'envelope-template.png')

# Геометрия текста замерена по оригинальному рендеру макета (2896×2172):
# строка 1 — верх ~y1458, строка 2 — на +31px; левый край ~x877; шрифт ~19px.
TEXT_LEFT = 877                 # левый край текста
TEXT_TOP = 1456                 # верх первой строки (координата draw.text)
BOX_W = 411                     # доступная ширина (1288 − 877), для ужатия длинных строк
BASE_FONT = 19                  # базовый размер шрифта (как в макете)
LINE_STEP = 31                  # межстрочный интервал (верх-к-верху) при BASE_FONT
MIN_FONT = 9
# Цвет измерен по оригинальному тексту макета — тёмно-серый, не чёрный.
COLOR = (48, 47, 45, 240)
SHEAR = 0.20                    # наклон текста вправо (как скошенный смарт-слой в макете)
BLUR = 0.6                      # мягкость штриха (печать сквозь конверт)
MAX_WIDTH = 1600               # ужимаем итог, чтобы не упереться в лимит nginx (413)


def font_candidates():
    return [
        os.environ.get('ENVELOPE_FONT'),
        os.path.join(BASE_DIR, 'assets', 'fonts', 'address.ttf'),
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/Library/Fonts/Arial.ttf',
        'C:\\Windows\\Fonts\\arial.ttf',
        'arial.ttf',
    ]


def load_font(size):
    from PIL import ImageFont
    for path in font_candidates():
        if not path:
            continue
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def line_width(draw, text, font):
    try:
        return draw.textlength(text, font=font)
    except Exception:
        bbox = draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0]


def fit_scale(draw, lines):
    """Базовый размер как в макете; ужимаем только если строка не влезает по ширине."""
    base = load_font(BASE_FONT)
    widest = max((line_width(draw, ln, base) for ln in lines), default=0)
    if widest <= BOX_W or widest <= 0:
        return BASE_FONT, 1.0
    scale = max(MIN_FONT / BASE_FONT, BOX_W / widest)
    return max(MIN_FONT, int(round(BASE_FONT * scale))), scale


def main():
    try:
        req = json.loads(sys.stdin.read() or '{}', strict=False)
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': 'bad json: %s' % exc}))
        return 1

    text = (req.get('text') or '').strip()
    out = req.get('out')
    if not text or not out:
        print(json.dumps({'ok': False, 'error': 'text and out required'}))
        return 1

    try:
        from PIL import Image, ImageDraw, ImageFilter
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': 'Pillow not installed: %s' % exc}))
        return 1

    try:
        tpl = Image.open(TEMPLATE).convert('RGBA')
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': 'template not found: %s' % exc}))
        return 1

    # До 2 строк: верхняя (≤45), нижняя (≤15).
    lines = [ln.strip() for ln in text.split('\n') if ln.strip()][:2]
    if not lines:
        print(json.dumps({'ok': False, 'error': 'empty text'}))
        return 1

    layer = Image.new('RGBA', tpl.size, (0, 0, 0, 0))
    measure = ImageDraw.Draw(layer)

    size, scale = fit_scale(measure, lines)
    font = load_font(size)
    step = LINE_STEP * scale  # межстрочный интервал масштабируется вместе со шрифтом

    # Текст в макете наклонён (смарт-слой скошен) — рисуем на отдельном слое
    # и применяем горизонтальный сдвиг (italic-shear), затем накладываем.
    pad = int(BASE_FONT * 2)
    tile_w = BOX_W + int((step * len(lines)) * SHEAR) + pad * 2
    tile_h = int(step * len(lines)) + pad * 2
    tile = Image.new('RGBA', (tile_w, tile_h), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(tile)
    for i, line in enumerate(lines):
        tdraw.text((pad, pad + i * step), line, font=font, fill=COLOR)
    if SHEAR:
        # Наклон вправо вокруг базовой линии нижней строки — низ текста остаётся
        # на месте (по TEXT_LEFT), верхние строки чуть уезжают вправо, как курсив.
        pivot = pad + step * (len(lines) - 1) + size * 0.8
        tile = tile.transform(
            (tile_w, tile_h), Image.AFFINE,
            (1, SHEAR, -SHEAR * pivot, 0, 1, 0),
            resample=Image.BICUBIC,
        )
    layer.alpha_composite(tile, (TEXT_LEFT - pad, TEXT_TOP - pad))

    if BLUR:
        layer = layer.filter(ImageFilter.GaussianBlur(BLUR))

    result = Image.alpha_composite(tpl, layer).convert('RGB')
    if result.width > MAX_WIDTH:
        new_h = round(result.height * MAX_WIDTH / result.width)
        result = result.resize((MAX_WIDTH, new_h), Image.LANCZOS)

    try:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result.save(out, 'JPEG', quality=88)
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': 'save failed: %s' % exc}))
        return 1

    print(json.dumps({'ok': True, 'out': out}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
