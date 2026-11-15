"""生成 GitHub Social preview 封面图（1280x640）。

用真实录屏帧做底图 + 左侧压暗 + 右侧标题，避免"设计感拼贴"和实际界面不符。
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

TMP = os.environ.get("SP_TMP", r"C:\Users\G15glow\AppData\Local\Temp\sp")
OUT = os.environ.get("SP_OUT", r"docs\images\social-preview.png")

W, H = 1280, 640
BG = (20, 22, 26)
ACCENT = (64, 196, 255)
AMBER = (255, 193, 7)
FG = (240, 242, 245)
MUTED = (154, 160, 170)


def font(size, bold=False):
    names = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc",
             r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"] if bold else [
            r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"]
    for n in names:
        if os.path.exists(n):
            try:
                return ImageFont.truetype(n, size)
            except Exception:
                continue
    return ImageFont.load_default()


def main():
    canvas = Image.new("RGB", (W, H), BG)

    # 1) 底图：真实界面帧，铺满右半
    frame_path = os.path.join(TMP, "frame.png")
    if os.path.exists(frame_path):
        shot = Image.open(frame_path).convert("RGB")
        # 等比缩放到覆盖右半区域（留出左边文字区）
        target_w, target_h = int(W * 0.72), H
        scale = max(target_w / shot.width, target_h / shot.height)
        shot = shot.resize((int(shot.width * scale) + 1, int(shot.height * scale) + 1), Image.LANCZOS)
        # 从右侧裁切
        left = max(0, shot.width - target_w)
        top = max(0, (shot.height - target_h) // 2)
        shot = shot.crop((left, top, left + target_w, top + target_h))
        # 轻微压暗，让叠加文字更清楚
        dark = Image.new("RGB", shot.size, (0, 0, 0))
        shot = Image.blend(shot, dark, 0.18)
        canvas.paste(shot, (W - target_w, 0))

    # 2) 左侧渐变压暗，和底图衔接
    grad_w = int(W * 0.52)
    grad = Image.new("RGB", (grad_w, H), BG)
    canvas.paste(grad, (0, 0))
    # 渐变过渡带
    band_w = 220
    for i in range(band_w):
        a = i / band_w
        strip = Image.new("RGB", (1, H), BG)
        x = grad_w + i
        if x >= W:
            break
        canvas.paste(Image.blend(strip, canvas.crop((x, 0, x + 1, H)), a), (x, 0))

    d = ImageDraw.Draw(canvas)

    # 3) 左侧文字
    x = 64
    y = 150

    f_title = font(66, bold=True)
    d.text((x, y), "MarkPlay", font=f_title, fill=FG)

    y += 92
    f_sub = font(28)
    d.text((x, y), "刷片 · 打点 · 出片", font=f_sub, fill=ACCENT)

    y += 52
    f_small = font(21)
    for line in [
        "触摸板推拉顺滑刷片",
        "A–G 随手打点 · [in,out] 区间",
        "导出 CSV / EDL · 应用内剪辑合并",
    ]:
        d.text((x, y), line, font=f_small, fill=MUTED)
        y += 34

    # 4) 底部标签
    f_tag = font(19)
    tags = ["mpv", "ffmpeg", "Electron", "Windows", "MIT"]
    tx = x
    ty = H - 78
    for t in tags:
        bbox = d.textbbox((0, 0), t, font=f_tag)
        tw = bbox[2] - bbox[0]
        d.rounded_rectangle([tx, ty, tx + tw + 22, ty + 32], radius=16,
                            outline=(60, 66, 78), width=1)
        d.text((tx + 11, ty + 5), t, font=f_tag, fill=MUTED)
        tx += tw + 34

    # 5) 右上角小徽标（琥珀色点睛）
    d.ellipse([W - 96, 34, W - 64, 66], fill=AMBER)

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    canvas.save(OUT, "PNG", optimize=True)
    print("wrote", OUT, os.path.getsize(OUT), "bytes", canvas.size)


if __name__ == "__main__":
    sys.exit(main())
