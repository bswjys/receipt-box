#!/usr/bin/env python3
"""영수증함 아이콘 생성기.

icon.svg / icon-maskable.svg 를 크로미엄으로 1024px 로 그린 뒤
아이폰 홈 화면(180px)과 PWA(192·512px) 크기로 줄여 저장한다.
꽉 찬 정사각형 PNG(투명 여백 없음)로 저장한다.

    LD_LIBRARY_PATH=/workspace/.browserlibs/lib python3 make_icons.py
"""
import os

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024

JOBS = [
    ("icon.svg", [(512, "icon-512.png"), (192, "icon-192.png"), (180, "icon-180.png")]),
    ("icon-maskable.svg", [(512, "icon-maskable-512.png")]),
]


def render(page, svg_name, out_path):
    url = "file://" + os.path.join(HERE, svg_name)
    page.set_viewport_size({"width": SIZE, "height": SIZE})
    page.goto(url)
    page.screenshot(path=out_path, clip={"x": 0, "y": 0, "width": SIZE, "height": SIZE})


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=1)
        for svg_name, targets in JOBS:
            master = os.path.join(HERE, ".dev", "_master_" + svg_name.replace(".svg", ".png"))
            os.makedirs(os.path.dirname(master), exist_ok=True)
            render(page, svg_name, master)
            img = Image.open(master).convert("RGB")
            for px, name in targets:
                img.resize((px, px), Image.LANCZOS).save(os.path.join(HERE, name), "PNG", optimize=True)
                print("saved", name, px)
            os.remove(master)
        browser.close()


if __name__ == "__main__":
    main()
