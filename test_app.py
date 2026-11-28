#!/usr/bin/env python3
"""영수증함 · 종이 영수증 보관 PWA · 자동 검증

    LD_LIBRARY_PATH=/workspace/.browserlibs/lib python3 test_app.py

검증 항목
  · PWA 자원(manifest·sw·꽉 찬 사각형 아이콘)과 첫 화면 빈 상태·첫 칸 등록 카드
  · 사진을 고르면 열리는 자르기 창 — 비율 칩(자유·1:1·3:4·4:3) · 모서리 드래그 · ↺ 90° 회전 · 자르기 적용/원본 그대로
  · 사진 2장 첨부(1800px JPEG 압축) · 2장 제한 · 폼/상세 사진 확대
  · 용도 4종 · 교환·환불 7일/14일/30일 · AS·보증 1년/2년 D-day 자동 계산
  · 이번 달 합계(금액·건수) · 미처리 건수 · 보관 중/처리완료 탭
  · 처리완료 이동 → 되돌리기
  · 검색(가게·금액·메모) · 용도 필터
  · JSON 백업 내려받기 / 복원(사진 포함)
  · 390 / 1280 가로 넘침 0 · 모든 input font-size >= 16px
  · 오프라인 실행 · 외부 전송 0 · 콘솔 오류 0
  · 스크린샷 downloads/receipt_box/01_home_390.png · 02_add_390.png · 03_detail_390.png · 04_crop_modal_390.png
"""
import asyncio
import base64
import calendar
import io
import json
import os
import socket
import sys
import threading
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw, ImageFont
from playwright.async_api import async_playwright

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(BASE))
SHOTS = os.path.join(ROOT, "downloads", "receipt_box")
FIX = os.path.join(BASE, ".dev", "fixtures")
TODAY = date.today()

PASS, FAIL, WARN, ERRORS, EXTERNAL = [], [], [], [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print(f"  ✓ {name}")
    else:
        FAIL.append(f"{name} — {detail}")
        print(f"  ✗ {name} — {detail}")


def warn(name, detail=""):
    WARN.append(f"{name} — {detail}")
    print(f"  ! {name} — {detail}")


# ── 날짜 (app.js 와 같은 방식) ──────────────────────────
def add_days(d, n):
    return d + timedelta(days=n)


def add_months(d, n):
    y = d.year + (d.month - 1 + n) // 12
    m = (d.month - 1 + n) % 12 + 1
    last = calendar.monthrange(y, m)[1]
    return date(y, m, min(d.day, last))


def korean(d):
    return f"{d.year}년 {d.month}월 {d.day}일"


def won(n):
    return f"{n:,}원"


def short(d):
    return f"{d.month}.{d.day}"


LAST_MONTH_DAY = date(TODAY.year, TODAY.month, 1) - timedelta(days=1)
THIS_YEAR = TODAY.year


# ── 테스트 사진 ─────────────────────────
KR_FONT = "/usr/share/fonts/pickle-hwp/NotoSansCJKkr-Regular.otf"


def font(size):
    try:
        return ImageFont.truetype(KR_FONT, size)
    except Exception:
        try:
            return ImageFont.load_default(size=size)
        except Exception:
            return ImageFont.load_default()


def make_receipt(path, store="이마트 고양점", total="45,300", accent="#1B64DA", tall=True):
    W, H = (760, 1240) if tall else (900, 1100)
    img = Image.new("RGB", (W, H), "#FCFBF8")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 168], fill=accent)
    d.text((44, 36), store, fill="white", font=font(42))
    d.text((44, 100), "영수증 · RECEIPT", fill="#D6E6FF", font=font(24))
    y = 224
    rows = [
        ("우유 2.3L", "6,900"),
        ("계란 30구", "8,980"),
        ("세제 리필", "12,400"),
        ("종량제 봉투", "2,500"),
        ("생수 2L x 6", "5,940"),
        ("합계", total),
    ]
    for label, price in rows:
        heavy = label == "합계"
        d.text((52, y), label, fill="#22262B", font=font(30 if heavy else 26))
        tw = d.textlength(price, font=font(30 if heavy else 26))
        d.text((W - 52 - tw, y), price, fill="#22262B", font=font(30 if heavy else 26))
        y += 58
    d.line([52, y + 4, W - 52, y + 4], fill="#C9CCD1", width=3)
    y += 46
    for line in ["2026. 11. 26  14:32", "카드 승인 8812-****-3421", "교환·환불은 7일 이내"]:
        d.text((52, y), line, fill="#5A6068", font=font(23))
        y += 44
    # 바코드
    bx, by = 52, H - 250
    for i in range(40):
        x = bx + i * 16
        h = 40 + (i * 53) % 110
        d.rectangle([x, by + 170 - h, x + 8, by + 170], fill="#1B1D21")
    d.text((52, H - 60), "POS 03   감사합니다", fill="#8A9098", font=font(22))
    img.save(path, "JPEG", quality=82)
    return path


def make_product(path, w=1600, h=1200):
    img = Image.new("RGB", (w, h), "#EDF3FB")
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=(int(236 - 40 * t), int(243 - 30 * t), 252))
    d.rounded_rectangle([w * 0.2, h * 0.14, w * 0.8, h * 0.84], radius=40, fill="#FFFFFF", outline="#C9D8EC", width=8)
    d.rounded_rectangle([w * 0.28, h * 0.24, w * 0.72, h * 0.56], radius=24, fill="#FFF7E4")
    d.text((w * 0.31, h * 0.31), "교환 영수증", fill="#C2670A", font=font(56))
    d.text((w * 0.31, h * 0.43), "사이즈 M", fill="#4E5968", font=font(44))
    grain = Image.effect_noise((w, h), 24).convert("RGB")
    img = Image.blend(img, grain, 0.13)
    img.save(path, "PNG")
    return path


PAPER_BOX = (150, 200, 1050, 1400)   # 자동 맞춤 확인용: 어두운 배경 위 밝은 영수증 위치


def make_paper_on_dark(path, W=1200, H=1600, box=PAPER_BOX):
    """어두운 책상 위에 놓인 밝은 영수증 — 자동 맞춤(영역 감지) 확인용."""
    img = Image.new("RGB", (W, H), "#2A2E35")
    px = img.load()
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            v = 34 + ((x * 7 + y * 13) % 9)
            px[x, y] = (v, v + 3, v + 7)
    d = ImageDraw.Draw(img)
    d.rectangle(box, fill="#FBFAF6")
    d.rectangle([box[0], box[1], box[2], box[1] + 96], fill="#1B64DA")
    d.text((box[0] + 40, box[1] + 28), "이마트 고양점", fill="#FFFFFF", font=font(46))
    for i in range(9):
        d.text((box[0] + 46, box[1] + 200 + i * 100), f"품목 {i + 1}", fill="#22262B", font=font(30))
        d.text((box[2] - 240, box[1] + 200 + i * 100), f"{1200 + i * 730:,}", fill="#22262B", font=font(30))
    img.save(path, "JPEG", quality=88)
    return path


def make_uniform(path, W=1000, H=1300, color="#6E6E6E"):
    """전체가 고른 색 — 자동 맞춤이 포기하고 전체로 폴백하는지 확인용."""
    Image.new("RGB", (W, H), color).save(path, "JPEG", quality=88)
    return path


def data_url_of(path):
    with open(path, "rb") as fh:
        return "data:image/jpeg;base64," + base64.b64encode(fh.read()).decode()


# ── 서버 ─────────────────────────
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    handler = lambda *a, **kw: QuietHandler(*a, directory=BASE, **kw)
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


async def new_page(browser, width=390, height=844, dsf=1):
    ctx = await browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=dsf,
        accept_downloads=True,
        locale="ko-KR",
    )
    page = await ctx.new_page()
    page.on("console", lambda m: ERRORS.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: ERRORS.append(f"[pageerror] {e}"))
    page.on(
        "request",
        lambda r: EXTERNAL.append(r.url) if r.url.startswith("http") and "127.0.0.1" not in r.url else None,
    )
    return ctx, page


async def goto(page, port):
    await page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="networkidle")
    await page.wait_for_function("document.documentElement.dataset.ready === '1'")


async def seed_items(page, items):
    await page.evaluate("(items) => window.__receiptbox.replaceAll(items)", items)
    await page.wait_for_timeout(200)


async def form_open(page):
    await page.click("#addCard")
    await page.wait_for_selector("#addWrap:not([hidden])")
    await page.wait_for_timeout(240)


async def pick_photo(page, paths, mode="apply", wait=680):
    """사진 선택 → 자르기 창 확인 → ‘자르기 적용’ 또는 ‘원본 그대로’"""
    if isinstance(paths, (str, os.PathLike)):
        paths = [str(paths)]
    await page.set_input_files("#photoInput", paths)
    await page.wait_for_selector("#cropWrap:not([hidden])")
    await page.wait_for_timeout(280)
    await page.click("#cropApply" if mode == "apply" else "#cropKeep")
    await page.wait_for_timeout(wait)


async def open_detail(page, item_id):
    await page.click(f'[data-id="{item_id}"]')
    await page.wait_for_selector("#detailWrap:not([hidden])")
    await page.wait_for_timeout(180)


# ── 시드 ─────────────────────────
def build_seed(receipt1, receipt2):
    return [
        dict(id="seed-e1", store="이마트 고양점", amount=45300, date=TODAY.isoformat(),
             purpose="refund", due=add_days(TODAY, 3).isoformat(), memo="사이즈 안 맞으면 교환",
             photos=[receipt1, receipt2], done=False, doneAt=None, createdAt=50, updatedAt=50),
        dict(id="seed-e2", store="GS25 고양점", amount=4500, date=TODAY.isoformat(),
             purpose="keep", due=None, memo="", photos=[], done=False, doneAt=None,
             createdAt=40, updatedAt=40),
        dict(id="seed-e3", store="쿠팡", amount=89000, date=TODAY.isoformat(),
             purpose="expense", due=None, memo="법인카드 정산 예정", photos=[], done=False,
             doneAt=None, createdAt=30, updatedAt=30),
        dict(id="seed-e4", store="동네마트", amount=12000, date=LAST_MONTH_DAY.isoformat(),
             purpose="keep", due=None, memo="생필품", photos=[], done=False, doneAt=None,
             createdAt=20, updatedAt=20),
        dict(id="seed-e5", store="삼성스토어", amount=250000, date=LAST_MONTH_DAY.isoformat(),
             purpose="expense", due=None, memo="", photos=[], done=True,
             doneAt=LAST_MONTH_DAY.isoformat(), createdAt=10, updatedAt=10),
    ]


async def run():
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(FIX, exist_ok=True)
    receipt_a = make_receipt(os.path.join(FIX, "receipt_a.jpg"), "이마트 고양점", "45,300")
    receipt_b = make_receipt(os.path.join(FIX, "receipt_b.jpg"), "이마트 고양점", "45,300", accent="#0F8A5F", tall=False)
    product = make_product(os.path.join(FIX, "product.png"))
    auto_dark = make_paper_on_dark(os.path.join(FIX, "auto_dark.jpg"))
    auto_flat = make_uniform(os.path.join(FIX, "auto_flat.jpg"))
    r1_url = data_url_of(receipt_a)
    r2_url = data_url_of(receipt_b)
    SEED = build_seed(r1_url, r2_url)
    MONTH_SUM = 45300 + 4500 + 89000

    srv, port = start_server()
    print(f"· 검증 서버 http://127.0.0.1:{port}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--lang=ko-KR"])

        # ─────────────────────────────────────────────
        print("\n[1] 첫 화면 · PWA 자원")
        ctx0, page0 = await new_page(browser)
        await goto(page0, port)
        check("앱 제목", "영수증함" in (await page0.title()))
        check("브랜드 제목", (await page0.inner_text(".brand-title")) == "영수증함")
        check("빈 목록 안내", await page0.is_visible("#emptyState"))
        check("빈 목록 문구", "아직 담아 둔 영수증이 없어요" in (await page0.inner_text("#emptyTitle")))
        check("이번 달 합계 0원", (await page0.inner_text("#sumMonth")) == "0원")
        check("이번 달 건수 0건", (await page0.inner_text("#sumMonthCount")) == "0건")
        check("미처리 0건", (await page0.inner_text("#pendingCount")) == "0")
        check("첫 칸이 영수증 사진등록 카드", (await page0.inner_text("#receiptGrid > :first-child")).replace("\n", " ").find("영수증 사진등록") >= 0,
              (await page0.inner_text("#receiptGrid > :first-child")))
        check("등록 카드 id", await page0.locator("#receiptGrid > #addCard").count() == 1)
        check("임박 알림은 숨김", await page0.is_hidden("#soonNote"))
        check("보관 중 탭 기본", await page0.get_attribute('#tabTabs button[data-tab="active"]', "aria-selected") == "true")

        meta_vp = await page0.get_attribute('meta[name="viewport"]', "content")
        check("뷰포트 확대 금지", "maximum-scale=1.0" in meta_vp and "user-scalable=no" in meta_vp, meta_vp)
        check("뷰포트 safe-area", "viewport-fit=cover" in meta_vp, meta_vp)

        manifest = await page0.evaluate("fetch('./manifest.webmanifest').then(r => r.json())")
        check("manifest 이름", manifest.get("short_name") == "영수증함", str(manifest.get("short_name")))
        check("manifest 아이콘 3종", len(manifest.get("icons", [])) == 3)
        check("manifest 테마", manifest.get("theme_color") == "#F2F4F6")
        check("manifest standalone", manifest.get("display") == "standalone")
        sw = await page0.evaluate("fetch('./sw.js').then(r => r.text())")
        check("sw 캐시 이름 receipt-box-v4", "receipt-box-v4" in sw)
        html = await page0.evaluate("fetch('./index.html').then(r => r.text())")
        check("index ?v=4", "styles.css?v=4" in html and "app.js?v=4" in html)
        css = await page0.evaluate("fetch('./styles.css').then(r => r.text())")
        check("css overflow-x clip", "overflow-x: clip" in css)
        check("css overscroll-behavior-y contain", "overscroll-behavior-y: contain" in css)
        check("css text-size-adjust", "-webkit-text-size-adjust: 100%" in css)
        check("css touch-action manipulation", "touch-action: manipulation" in css)
        check("css input 16px 기본", "font-size: 16px" in css)
        await page0.wait_for_timeout(700)
        regs = await page0.evaluate("navigator.serviceWorker.getRegistrations().then(rs => rs.length)")
        check("서비스워커 자동 등록", regs >= 1, str(regs))
        for asset in ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
                      "icon-180.png", "manifest.webmanifest"]:
            ok = await page0.evaluate(f"fetch('./{asset}').then(r => r.ok)")
            check(f"{asset} 제공", ok)
        with Image.open(os.path.join(BASE, "icon-512.png")) as im:
            check("icon-512 512×512", im.size == (512, 512), str(im.size))
            rgba = im.convert("RGBA")
            corners = [rgba.getpixel(p) for p in [(0, 0), (511, 0), (0, 511), (511, 511)]]
            check("icon-512 꽉 찬 사각형(모서리 불투명)", all(c[3] == 255 for c in corners), str(corners))
            check("icon-512 모서리까지 파란 바탕", all(c[2] > 150 and c[0] < 140 for c in corners), str(corners))
        with Image.open(os.path.join(BASE, "icon-180.png")) as im:
            check("icon-180 180×180", im.size == (180, 180), str(im.size))
        app_src = open(os.path.join(BASE, "app.js"), encoding="utf-8").read()
        check("서버·실시간 공유 코드 없음", "firebase" not in app_src.lower() and "websocket" not in app_src.lower())
        check("IndexedDB 저장", "indexedDB" in app_src and "receipt-box" in app_src)
        check("localStorage 대체 저장", "receiptbox.v1" in app_src)
        check("오프라인 등록 코드", "serviceWorker" in app_src)
        await ctx0.close()

        # ─────────────────────────────────────────────
        print("\n[2] 등록 — 사진 2장 · 금액 · 용도 · 마감일")
        ctx1, page1 = await new_page(browser)
        await goto(page1, port)
        await form_open(page1)
        check("등록 시트 열림", await page1.is_visible("#addWrap"))
        check("제목 '영수증 등록'", (await page1.inner_text("#addTitle")) == "영수증 등록")
        check("구매일 기본 오늘", (await page1.input_value("#fDate")) == TODAY.isoformat())
        check("구매일 한글 표시", korean(TODAY) in (await page1.inner_text("#dateHint")), await page1.inner_text("#dateHint"))
        check("기본 용도 = 교환·환불", await page1.get_attribute('#purposeSeg button[data-purpose="refund"]', "aria-pressed") == "true")
        check("용도 4종", await page1.locator("#purposeSeg button").count() == 4)
        check("교환·환불 마감일 칸 보임", await page1.is_visible("#dueBox"))
        labels = await page1.locator("#dueChips button").all_inner_texts()
        check("교환·환불 빠른 마감일 7·14·30일", labels == ["7일", "14일", "30일"], str(labels))

        await page1.click('#purposeSeg button[data-purpose="keep"]')
        await page1.wait_for_timeout(120)
        check("보관용이면 마감일 칸 숨김", await page1.is_hidden("#dueBox"))
        await page1.click('#purposeSeg button[data-purpose="expense"]')
        await page1.wait_for_timeout(120)
        check("경비·정산도 마감일 칸 숨김", await page1.is_hidden("#dueBox"))
        await page1.click('#purposeSeg button[data-purpose="as"]')
        await page1.wait_for_timeout(120)
        as_labels = await page1.locator("#dueChips button").all_inner_texts()
        check("AS·보증 빠른 선택 1년·2년", as_labels == ["1년", "2년"], str(as_labels))
        await page1.click('#purposeSeg button[data-purpose="refund"]')
        await page1.wait_for_timeout(120)

        await page1.fill("#fStore", "이마트 고양점 · 생필품")
        await page1.fill("#fAmount", "45300")
        check("금액 콤마 표시", (await page1.input_value("#fAmount")) == "45,300")

        # 사진 2장
        await pick_photo(page1, receipt_a, "keep")
        check("사진 1장 첨부", await page1.locator(".photo-cell").count() == 1)
        stored = await page1.evaluate("() => window.__receiptbox.form.photos[0]")
        check("사진은 data URL JPEG", stored.startswith("data:image/jpeg;base64,"), stored[:32])
        raw = base64.b64decode(stored.split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as im:
            check("사진 1800px 이하", max(im.size) <= 1800, f"{im.size}")
            check("사진 비율 유지", abs(im.size[0] / im.size[1] - 760 / 1240) < 0.02, f"{im.size}")
        check("원본보다 작게 압축", len(raw) < os.path.getsize(receipt_a), f"{len(raw)} vs {os.path.getsize(receipt_a)}")

        await pick_photo(page1, product, "keep")
        check("사진 2장까지 첨부", await page1.locator(".photo-cell").count() == 2,
              str(await page1.locator(".photo-cell").count()))
        await page1.set_input_files("#photoInput", [product])
        await page1.wait_for_timeout(350)
        check("3장째는 안내 문구", "2장까지" in (await page1.inner_text("#toast")), await page1.inner_text("#toast"))
        check("3장째는 담기지 않음", await page1.locator(".photo-cell").count() == 2)
        await page1.click('.photo-del[data-remove="1"]')
        await page1.wait_for_timeout(150)
        check("사진 빼기", await page1.locator(".photo-cell").count() == 1)
        await pick_photo(page1, product, "keep")
        check("다시 2장", await page1.locator(".photo-cell").count() == 2)
        await page1.click('.photo[data-photo="1"]')
        await page1.wait_for_timeout(220)
        check("폼에서 사진 크게 보기", await page1.is_visible("#zoomWrap"))
        check("확대한 사진이 두 번째 사진", (await page1.get_attribute("#zoomImg", "src")) ==
              (await page1.evaluate("() => window.__receiptbox.form.photos[1]")))
        await page1.click("#zoomClose")
        await page1.wait_for_timeout(150)
        check("확대 닫힘", await page1.is_hidden("#zoomWrap"))

        # 7일 / 14일 / 30일
        await page1.click('#dueChips button[data-due="d7"]')
        await page1.wait_for_timeout(150)
        d7 = add_days(TODAY, 7)
        check("7일 마감일 자동 계산", (await page1.input_value("#fDue")) == d7.isoformat(), await page1.input_value("#fDue"))
        check("7일 D-day 미리보기", f"{korean(d7)}까지 · 7일 남았어요" == (await page1.inner_text("#dueHint")),
              await page1.inner_text("#dueHint"))
        check("7일 칩 선택 표시", await page1.get_attribute('#dueChips button[data-due="d7"]', "aria-pressed") == "true")
        await page1.click('#dueChips button[data-due="d14"]')
        await page1.wait_for_timeout(150)
        d14 = add_days(TODAY, 14)
        check("14일 마감일 자동 계산", (await page1.input_value("#fDue")) == d14.isoformat(), await page1.input_value("#fDue"))
        check("14일 D-day 미리보기", "14일 남았어요" in (await page1.inner_text("#dueHint")), await page1.inner_text("#dueHint"))
        await page1.click('#dueChips button[data-due="d30"]')
        await page1.wait_for_timeout(150)
        check("30일 마감일 자동 계산", (await page1.input_value("#fDue")) == add_days(TODAY, 30).isoformat())
        check("30일 D-day", "30일 남았어요" in (await page1.inner_text("#dueHint")))

        # 구매일을 바꾸면 마감일도 따라 움직인다
        await page1.click('#dueChips button[data-due="d7"]')
        await page1.wait_for_timeout(120)
        await page1.fill("#fDate", TODAY.isoformat())
        await page1.dispatch_event("#fDate", "change")
        await page1.wait_for_timeout(150)
        check("7일 칩 다시 선택", await page1.get_attribute('#dueChips button[data-due="d7"]', "aria-pressed") == "true")

        await page1.click("#addSave")
        await page1.wait_for_timeout(600)
        check("등록 저장", await page1.locator(".receipt").count() == 1, f"{await page1.locator('.receipt').count()}개")
        card = await page1.inner_text(".receipt")
        check("카드 가게명", "이마트 고양점" in card, card)
        check("카드 금액", "45,300원" in card, card)
        check("카드 용도 pill", "교환·환불" in card, card)
        check("카드 D-7 배지", "D-7" in card, card)
        check("카드 구매일", short(TODAY) in card, card)
        check("카드 썸네일", await page1.locator(".receipt .thumb img").count() == 1)
        check("등록 후 이번 달 합계", (await page1.inner_text("#sumMonth")) == "45,300원")
        check("등록 후 이번 달 1건", (await page1.inner_text("#sumMonthCount")) == "1건")
        check("등록 후 미처리 1건", (await page1.inner_text("#pendingCount")) == "1")
        check("등록 후 빈 안내 사라짐", await page1.is_hidden("#emptyState"))

        # 저장이 실제로 남았는지 — 새로고침 후 확인
        await page1.reload(wait_until="networkidle")
        await page1.wait_for_function("document.documentElement.dataset.ready === '1'")
        await page1.wait_for_timeout(300)
        check("새로고침 후에도 1개", await page1.locator(".receipt").count() == 1)
        saved = await page1.evaluate("() => window.__receiptbox.items[0]")
        check("사진 2장 저장", len(saved["photos"]) == 2, str(len(saved["photos"])))
        check("금액 저장", saved["amount"] == 45300, str(saved["amount"]))
        check("용도 저장", saved["purpose"] == "refund", str(saved["purpose"]))
        check("마감일 저장", saved["due"] == d7.isoformat(), str(saved["due"]))
        check("저장 위치 IndexedDB", (await page1.evaluate("() => window.__receiptbox.view.mode")) == "idb",
              await page1.evaluate("() => window.__receiptbox.view.mode"))

        # ─────────────────────────────────────────────
        print("\n[3] AS·보증 마감 · 경비·정산 등록")
        await form_open(page1)
        await page1.fill("#fStore", "삼성서비스센터 · 세탁기")
        await page1.fill("#fAmount", "1200000")
        await page1.click('#purposeSeg button[data-purpose="as"]')
        await page1.wait_for_timeout(150)
        await page1.click('#dueChips button[data-due="m12"]')
        await page1.wait_for_timeout(150)
        as12 = add_months(TODAY, 12)
        check("AS 1년 마감일 계산", (await page1.input_value("#fDue")) == as12.isoformat(), await page1.input_value("#fDue"))
        check("AS 마감일 라벨", (await page1.inner_text("#dueLabel")) == "보증 만료일")
        await page1.click('#dueChips button[data-due="m24"]')
        await page1.wait_for_timeout(150)
        check("AS 2년 마감일 계산", (await page1.input_value("#fDue")) == add_months(TODAY, 24).isoformat())
        await page1.click('#dueChips button[data-due="m12"]')
        await page1.wait_for_timeout(120)
        await page1.click("#addSave")
        await page1.wait_for_timeout(550)
        check("AS 영수증 저장", await page1.locator(".receipt").count() == 2)
        as_card = await page1.inner_text('[data-id] >> nth=1')
        cards = await page1.locator(".receipt").all_inner_texts()
        as_card = [c for c in cards if "세탁기" in c][0]
        check("AS pill", "AS·보증" in as_card, as_card)
        check("AS 시계형 D-day(365일)", f"D-{max(364, (as12 - TODAY).days)}" in as_card, as_card)

        await form_open(page1)
        await page1.fill("#fStore", "쿠팡 · 사무용품")
        await page1.fill("#fAmount", "18900")
        await page1.click('#purposeSeg button[data-purpose="expense"]')
        await page1.wait_for_timeout(150)
        await page1.click("#addSave")
        await page1.wait_for_timeout(500)
        check("경비·정산 저장", await page1.locator(".receipt").count() == 3)
        check("마감 없는 영수증엔 D-day 배지 없음",
              await page1.locator(".receipt").nth(2).locator(".dday").count() == 0)
        check("이번 달 합계 3건 반영", (await page1.inner_text("#sumMonth")) == won(45300 + 1200000 + 18900))
        check("이번 달 3건", (await page1.inner_text("#sumMonthCount")) == "3건")
        check("미처리 3건", (await page1.inner_text("#pendingCount")) == "3")
        await ctx1.close()

        # ─────────────────────────────────────────────
        print("\n[4] 요약 · 정렬 · 탭 · 용도 필터")
        ctx2, page2 = await new_page(browser)
        await goto(page2, port)
        await seed_items(page2, SEED)
        check("시드 4개 보관 중", await page2.locator(".receipt").count() == 4,
              f"{await page2.locator('.receipt').count()}개")
        check("이번 달 합계(금액)", (await page2.inner_text("#sumMonth")) == won(MONTH_SUM), await page2.inner_text("#sumMonth"))
        check("이번 달 합계(건수)", (await page2.inner_text("#sumMonthCount")) == "3건")
        check("미처리 2건(보관용 제외)", (await page2.inner_text("#pendingCount")) == "2",
              await page2.inner_text("#pendingCount"))
        check("보관 중 탭 4", (await page2.inner_text("#countActive")) == "4")
        check("처리완료 탭 1", (await page2.inner_text("#countDone")) == "1")
        check("임박 알림 보임", await page2.is_visible("#soonNote"))
        check("임박 알림 문구", "1건" in (await page2.inner_text("#soonNote")), await page2.inner_text("#soonNote"))

        order = await page2.locator(".receipt").evaluate_all(
            "els => els.map(e => e.getAttribute('data-id'))")
        check("마감 임박이 맨 앞", order and order[0] == "seed-e1", str(order))
        check("목록 개수 문구", (await page2.inner_text("#listCount")) == "영수증 4개",
              await page2.inner_text("#listCount"))

        await page2.click('#purposeChips button[data-purpose="refund"]')
        await page2.wait_for_timeout(220)
        check("교환·환불 필터 1개", await page2.locator(".receipt").count() == 1)
        await page2.click('#purposeChips button[data-purpose="keep"]')
        await page2.wait_for_timeout(220)
        check("보관용 필터 2개", await page2.locator(".receipt").count() == 2)
        check("보관용 필터 문구", (await page2.inner_text("#listCount")) == "영수증 2개")
        await page2.click('#purposeChips button[data-purpose="all"]')
        await page2.wait_for_timeout(200)
        check("전체 필터 복귀", await page2.locator(".receipt").count() == 4)

        await page2.click('#tabTabs button[data-tab="done"]')
        await page2.wait_for_timeout(250)
        check("처리완료 탭 1개", await page2.locator(".receipt").count() == 1)
        check("처리완료 탭엔 등록 카드 없음", await page2.locator("#addCard").count() == 0)
        check("처리완료 카드 표시", "처리완료" in (await page2.inner_text(".receipt")))
        check("처리완료 문구", (await page2.inner_text("#listCount")) == "처리완료 1개")
        await page2.click('#tabTabs button[data-tab="active"]')
        await page2.wait_for_timeout(200)

        # ─────────────────────────────────────────────
        print("\n[5] 검색")
        await page2.fill("#searchInput", "생필품")
        await page2.wait_for_timeout(350)
        check("메모 검색", await page2.locator(".receipt").count() == 1)
        check("메모 검색 결과", "동네마트" in (await page2.inner_text(".receipt")))
        await page2.fill("#searchInput", "쿠팡")
        await page2.wait_for_timeout(350)
        check("가게명 검색", await page2.locator(".receipt").count() == 1 and "89,000원" in (await page2.inner_text(".receipt")))
        await page2.fill("#searchInput", "45300")
        await page2.wait_for_timeout(350)
        check("금액(숫자) 검색", await page2.locator(".receipt").count() == 1 and "이마트" in (await page2.inner_text(".receipt")))
        await page2.fill("#searchInput", "45,300")
        await page2.wait_for_timeout(350)
        check("금액(콤마) 검색", await page2.locator(".receipt").count() == 1)
        await page2.fill("#searchInput", "없는가게")
        await page2.wait_for_timeout(350)
        check("검색 결과 없음 안내", await page2.is_visible("#emptyState") and "찾는 영수증" in (await page2.inner_text("#emptyTitle")))
        check("검색 지우기 버튼", await page2.is_visible("#searchClear"))
        await page2.click("#searchClear")
        await page2.wait_for_timeout(320)
        check("검색 지우면 전체 4개", await page2.locator(".receipt").count() == 4)

        # ─────────────────────────────────────────────
        print("\n[6] 상세 · 사진 확대 · 처리완료/되돌리기")
        await open_detail(page2, "seed-e1")
        body = await page2.inner_text("#detailBody")
        check("상세 가게명", "이마트 고양점" in body, body[:120])
        check("상세 금액", "45,300원" in body)
        check("상세 마감 안내", f"{korean(add_days(TODAY, 3))}까지 · 3일 남았어요" in body, body[:200])
        check("상세 용도", "교환·환불" in body)
        check("상세 구매일", korean(TODAY) in body)
        check("상세 메모", "사이즈 안 맞으면 교환" in body)
        check("상세 사진 2장", await page2.locator(".detail-body .shot, #detailBody .shot").count() == 2)
        await page2.click('#detailBody .shot[data-zoom="1"]')
        await page2.wait_for_timeout(220)
        check("상세 사진 크게 보기", await page2.is_visible("#zoomWrap"))
        check("확대 사진 = 저장 사진", (await page2.get_attribute("#zoomImg", "src")) == r2_url)
        await page2.click("#zoomWrap", position={"x": 8, "y": 8})
        await page2.wait_for_timeout(160)
        check("배경 누르면 확대 닫힘", await page2.is_hidden("#zoomWrap"))

        check("처리완료 버튼", (await page2.inner_text("#detailDone")) == "처리완료")
        await page2.click("#detailDone")
        await page2.wait_for_timeout(400)
        check("처리완료 후 상세 닫힘", await page2.is_hidden("#detailWrap"))
        check("처리완료 후 보관 중 3", (await page2.inner_text("#countActive")) == "3",
              await page2.inner_text("#countActive"))
        check("처리완료 후 처리완료 2", (await page2.inner_text("#countDone")) == "2")
        check("처리완료 후 미처리 1", (await page2.inner_text("#pendingCount")) == "1")
        check("처리완료 후 이번 달 합계 그대로", (await page2.inner_text("#sumMonth")) == won(MONTH_SUM))
        await page2.click('#tabTabs button[data-tab="done"]')
        await page2.wait_for_timeout(220)
        done_ids = await page2.locator(".receipt").evaluate_all("els => els.map(e => e.getAttribute('data-id'))")
        check("처리완료 탭에 이마트", "seed-e1" in done_ids, str(done_ids))
        await open_detail(page2, "seed-e1")
        check("되돌리기 버튼", (await page2.inner_text("#detailDone")) == "되돌리기")
        check("상세에 처리완료 날짜", "처리완료했어요" in (await page2.inner_text("#detailBody")))
        await page2.click("#detailDone")
        await page2.wait_for_timeout(400)
        check("되돌리면 보관 중 4", (await page2.inner_text("#countActive")) == "4")
        check("되돌리면 처리완료 1", (await page2.inner_text("#countDone")) == "1")
        check("되돌리면 미처리 2", (await page2.inner_text("#pendingCount")) == "2")
        await page2.click('#tabTabs button[data-tab="active"]')
        await page2.wait_for_timeout(200)

        # ─────────────────────────────────────────────
        print("\n[7] 수정 · 삭제")
        await open_detail(page2, "seed-e4")
        await page2.click("#detailEdit")
        await page2.wait_for_timeout(280)
        check("수정 시트 열림", await page2.is_visible("#addWrap"))
        check("수정 제목", (await page2.inner_text("#addTitle")) == "영수증 수정")
        check("가게명 채워짐", (await page2.input_value("#fStore")) == "동네마트")
        check("금액 채워짐", (await page2.input_value("#fAmount")) == "12,000")
        check("용도 유지", await page2.get_attribute('#purposeSeg button[data-purpose="keep"]', "aria-pressed") == "true")
        check("보관용은 마감일 숨김", await page2.is_hidden("#dueBox"))
        await page2.fill("#fAmount", "13500")
        await page2.click("#addSave")
        await page2.wait_for_timeout(450)
        check("수정 금액 반영", "13,500원" in (await page2.inner_text('[data-id="seed-e4"]')))
        check("수정해도 처리 상태 유지", await page2.evaluate(
            "() => window.__receiptbox.items.find(i => i.id === 'seed-e4').done") is False)

        await open_detail(page2, "seed-e2")
        await page2.click("#detailDelete")
        await page2.wait_for_timeout(250)
        check("삭제 확인 창", await page2.is_visible("#confirmWrap"))
        check("확인 창에 가게명", "GS25" in (await page2.inner_text("#confirmDesc")),
              await page2.inner_text("#confirmDesc"))
        await page2.click("#confirmCancel")
        await page2.wait_for_timeout(250)
        check("취소하면 그대로", await page2.locator(".receipt").count() == 4)
        await page2.click("#detailDelete")
        await page2.wait_for_timeout(200)
        await page2.click("#confirmOk")
        await page2.wait_for_timeout(450)
        check("삭제 후 3개", await page2.locator(".receipt").count() == 3)
        check("삭제 후 상세 닫힘", await page2.is_hidden("#detailWrap"))
        check("삭제 반영", await page2.evaluate("() => window.__receiptbox.items.length") == 4)
        await page2.reload(wait_until="networkidle")
        await page2.wait_for_function("document.documentElement.dataset.ready === '1'")
        await page2.wait_for_timeout(350)
        check("삭제가 저장됨", await page2.evaluate("() => window.__receiptbox.items.length") == 4)

        # ─────────────────────────────────────────────
        print("\n[8] JSON 백업 · 복원")
        await page2.click("#moreBtn")
        await page2.wait_for_timeout(280)
        check("더보기 시트", await page2.is_visible("#moreWrap"))
        info = await page2.inner_text("#moreInfo")
        check("백업 정보 표시", "영수증 4개" in info and "사진 2장" in info, info)
        backup_path = os.path.join(FIX, "backup.json")
        try:
            async with page2.expect_download(timeout=12000) as dl_info:
                await page2.click("#backupBtn")
            dl = await dl_info.value
            await dl.save_as(backup_path)
            check("백업 파일 이름", dl.suggested_filename == f"receipt-box-backup-{TODAY.isoformat()}.json",
                  dl.suggested_filename)
            data = json.load(open(backup_path, encoding="utf-8"))
            check("백업 JSON app", data.get("app") == "receipt-box")
            check("백업 영수증 4개", len(data.get("items", [])) == 4, str(len(data.get("items", []))))
            check("백업에 사진 포함", any(it.get("photos") for it in data["items"]))
            check("백업에 이름들", {it["store"] for it in data["items"]} ==
                  {"이마트 고양점", "쿠팡", "동네마트", "삼성스토어"})
            check("백업 후 더보기 닫힘", await page2.is_hidden("#moreWrap"))
        except Exception as exc:
            check("백업 내려받기", False, str(exc))

        await ctx2.close()
        ctx3, page3 = await new_page(browser)
        await goto(page3, port)
        check("복원 전 빈 목록", await page3.locator(".receipt").count() == 0)
        await page3.click("#moreBtn")
        await page3.wait_for_timeout(220)
        await page3.set_input_files("#restoreInput", backup_path)
        await page3.wait_for_timeout(700)
        check("복원 확인 창", await page3.is_visible("#confirmWrap"))
        check("복원 개수 안내", "4개" in (await page3.inner_text("#confirmTitle")),
              await page3.inner_text("#confirmTitle"))
        await page3.click("#confirmOk")
        await page3.wait_for_timeout(700)
        check("복원 후 보관 중 3개", await page3.locator(".receipt").count() == 3,
              f"{await page3.locator('.receipt').count()}개")
        check("복원 후 전체 4개", await page3.evaluate("() => window.__receiptbox.items.length") == 4,
              str(await page3.evaluate("() => window.__receiptbox.items.length")))
        check("복원 후 처리완료 1개", (await page3.inner_text("#countDone")) == "1")
        check("복원된 사진 썸네일", await page3.locator(".receipt .thumb img").count() == 1)
        restored = await page3.evaluate("() => window.__receiptbox.items")
        imart = [i for i in restored if i["id"] == "seed-e1"][0]
        check("복원 사진 동일", imart["photos"][0] == r1_url and imart["photos"][1] == r2_url)
        check("복원 금액", imart["amount"] == 45300, str(imart["amount"]))
        check("복원 용도", imart["purpose"] == "refund")
        check("복원 마감일", imart["due"] == add_days(TODAY, 3).isoformat())
        check("복원 후 이번 달 합계", (await page3.inner_text("#sumMonth")) == won(45300 + 89000),
              await page3.inner_text("#sumMonth"))
        check("복원 후 미처리 2건", (await page3.inner_text("#pendingCount")) == "2")
        await page3.reload(wait_until="networkidle")
        await page3.wait_for_function("document.documentElement.dataset.ready === '1'")
        await page3.wait_for_timeout(300)
        check("복원이 저장됨", await page3.evaluate("() => window.__receiptbox.items.length") == 4,
              str(await page3.evaluate("() => window.__receiptbox.items.length")))
        await ctx3.close()

        # ─────────────────────────────────────────────
        print("\n[9] 사진 자르기(크롭)")
        ctx7, page7 = await new_page(browser, width=390, height=844, dsf=2)
        await goto(page7, port)
        await form_open(page7)
        await page7.fill("#fStore", "크롭 테스트")

        await page7.set_input_files("#photoInput", [receipt_a])
        await page7.wait_for_selector("#cropWrap:not([hidden])")
        await page7.wait_for_timeout(320)
        check("사진을 고르면 자르기 창이 먼저 열림", await page7.is_visible("#cropWrap"))
        check("자르기 전에는 담기지 않음", await page7.locator(".photo-cell").count() == 0)
        check("자르기 창 제목", "사진 자르기" in (await page7.inner_text(".crop-title")), await page7.inner_text(".crop-title"))
        ratios = await page7.locator("#cropRatios button").all_inner_texts()
        check("비율 칩 자유·1:1·3:4·4:3", ratios == ["자유", "1:1", "3:4", "4:3"], str(ratios))
        check("기본 비율은 자유", await page7.get_attribute('#cropRatios button[data-ratio="free"]', "aria-pressed") == "true")
        check("회전 버튼 있음", "90°" in (await page7.inner_text("#cropRotate")), await page7.inner_text("#cropRotate"))
        check("원본 그대로 버튼 있음", (await page7.inner_text("#cropKeep")) == "원본 그대로")
        check("자르기 적용 버튼 있음", (await page7.inner_text("#cropApply")) == "자르기 적용")
        check("자르기 중 body.modal-open", await page7.evaluate("() => document.body.classList.contains('modal-open')"))
        check("자르기 무대 touch-action none",
              await page7.evaluate("() => getComputedStyle(document.getElementById('cropStage')).touchAction") == "none")
        check("자를 영역 박스 드래그 가능(touch-action none)",
              await page7.evaluate("() => getComputedStyle(document.getElementById('cropFrame')).touchAction") == "none")
        over = await page7.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390 자르기 창 가로 넘침 0", over <= 1, f"{over}px")

        st = await page7.evaluate("() => window.__receiptbox.crop")
        check("자르기 소스 = 원본 크기", (st["source"]["w"], st["source"]["h"]) == (760, 1240), str(st["source"]))
        check("처음엔 사진 전체가 자를 영역", st["rect"]["w"] >= 300 and st["rect"]["h"] >= 300, str(st["rect"]))
        check("모서리 핸들 4개", await page7.locator(".crop-handle").count() == 4)


        # 1:1로 잘라 담기
        await page7.click('#cropRatios button[data-ratio="1:1"]')
        await page7.wait_for_timeout(240)
        st = await page7.evaluate("() => window.__receiptbox.crop")
        check("1:1 비율 선택 표시", await page7.get_attribute('#cropRatios button[data-ratio="1:1"]', "aria-pressed") == "true")
        check("1:1 자를 영역은 정사각형", abs(st["rect"]["w"] - st["rect"]["h"]) <= 1, str(st["rect"]))
        side_view = round(st["rect"]["w"] * st["scale"])
        check("자를 영역 크기 안내", f"{side_view}" in (await page7.inner_text("#cropSize")), await page7.inner_text("#cropSize"))
        await page7.click("#cropApply")
        await page7.wait_for_timeout(750)
        check("자르기 적용하면 담김", await page7.locator(".photo-cell").count() == 1,
              str(await page7.locator(".photo-cell").count()))
        check("적용 뒤 자르기 창 닫힘", await page7.is_hidden("#cropWrap"))
        saved = await page7.evaluate("() => window.__receiptbox.form.photos[0]")
        check("자른 사진은 data URL JPEG", saved.startswith("data:image/jpeg;base64,"), saved[:32])
        raw = base64.b64decode(saved.split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as im:
            check("자른 사진 정사각형", abs(im.size[0] - im.size[1]) <= 2, str(im.size))
            check("자른 사진 = 고른 영역 크기", abs(im.size[0] - side_view) <= 2, f"{im.size} vs {side_view}")
            check("자른 사진도 1800px 이하", max(im.size) <= 1800, str(im.size))
        check("자른 사진이 원본보다 작음", len(raw) < os.path.getsize(receipt_a), f"{len(raw)} vs {os.path.getsize(receipt_a)}")

        # 회전 · 모서리 드래그 · 자유 비율
        await page7.click('.photo-del[data-remove="0"]')
        await page7.wait_for_timeout(200)
        await page7.set_input_files("#photoInput", [product])
        await page7.wait_for_selector("#cropWrap:not([hidden])")
        await page7.wait_for_timeout(320)
        before = await page7.evaluate("() => window.__receiptbox.crop.source")
        await page7.click("#cropRotate")
        await page7.wait_for_timeout(320)
        after = await page7.evaluate("() => window.__receiptbox.crop.source")
        check("↺ 90° 회전하면 가로·세로가 바뀜", (after["w"], after["h"]) == (before["h"], before["w"]),
              f"{before} → {after}")
        over = await page7.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("회전 뒤에도 가로 넘침 0", over <= 1, f"{over}px")

        r1 = await page7.evaluate("() => window.__receiptbox.crop.rect")
        hb = await page7.locator("#cropFrame .crop-handle.br").bounding_box()
        await page7.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
        await page7.mouse.down()
        await page7.mouse.move(hb["x"] + hb["width"] / 2 - 80, hb["y"] + hb["height"] / 2 - 80, steps=10)
        await page7.mouse.up()
        await page7.wait_for_timeout(260)
        r2 = await page7.evaluate("() => window.__receiptbox.crop.rect")
        check("모서리를 끌면 자를 영역이 줄어듦", r2["w"] < r1["w"] - 20 and r2["h"] < r1["h"] - 20, f"{r1} → {r2}")
        view = await page7.locator("#cropView").bounding_box()
        check("모서리 드래그 뒤에도 사진 안쪽",
              r2["x"] >= -1 and r2["y"] >= -1
              and r2["x"] + r2["w"] <= view["width"] + 1
              and r2["y"] + r2["h"] <= view["height"] + 1, str(r2))
        await page7.click("#cropApply")
        await page7.wait_for_timeout(750)
        crop2 = await page7.evaluate("() => window.__receiptbox.form.photos[0]")
        with Image.open(io.BytesIO(base64.b64decode(crop2.split(",", 1)[1]))) as im:
            check("회전한 사진은 세로가 김", im.size[1] > im.size[0], str(im.size))
            want = r2["w"] / r2["h"]
            check("자른 사진 비율 = 고른 영역 비율", abs(im.size[0] / im.size[1] - want) < 0.02,
                  f"{im.size} vs {want:.3f}")
            check("회전·자른 사진도 1800px 이하", max(im.size) <= 1800, str(im.size))

        # 원본 그대로 · 취소
        await page7.click('.photo-del[data-remove="0"]')
        await page7.wait_for_timeout(200)
        await pick_photo(page7, receipt_a, "keep")
        check("원본 그대로 담기", await page7.locator(".photo-cell").count() == 1)
        keep = await page7.evaluate("() => window.__receiptbox.form.photos[0]")
        with Image.open(io.BytesIO(base64.b64decode(keep.split(",", 1)[1]))) as im:
            check("원본 그대로는 자르지 않음", im.size == (760, 1240), str(im.size))
        await page7.set_input_files("#photoInput", [product])
        await page7.wait_for_selector("#cropWrap:not([hidden])")
        await page7.wait_for_timeout(280)
        await page7.click("#cropCancel")
        await page7.wait_for_timeout(420)
        check("취소하면 자르기 창 닫힘", await page7.is_hidden("#cropWrap"))
        check("취소하면 사진도 안 담힘", await page7.locator(".photo-cell").count() == 1)

        await page7.click("#addSave")
        await page7.wait_for_timeout(650)
        check("자른 사진으로 영수증 저장", await page7.locator(".receipt").count() == 1, str(await page7.locator('.receipt').count()))
        stored_crop = await page7.evaluate("() => window.__receiptbox.items[0].photos[0]")
        with Image.open(io.BytesIO(base64.b64decode(stored_crop.split(",", 1)[1]))) as im:
            check("저장된 사진이 원본 그대로", im.size == (760, 1240), str(im.size))

        # ✨ 자동 맞춤 — 어두운 배경 위 밝은 영수증
        await form_open(page7)
        await page7.set_input_files("#photoInput", [auto_dark])
        await page7.wait_for_selector("#cropWrap:not([hidden])")
        await page7.wait_for_timeout(420)
        check("✨ 자동 맞춤 버튼 있음", "자동 맞춤" in (await page7.inner_text("#cropAuto")),
              await page7.inner_text("#cropAuto"))
        st = await page7.evaluate("() => window.__receiptbox.crop")
        det = st["detected"]
        check("자동 맞춤: 어두운 배경에서 밝은 종이를 찾음", det is not None, str(det))
        r0 = st["rect"]
        sc = st["scale"]
        bx0, by0 = r0["x"] * sc, r0["y"] * sc
        bx1, by1 = (r0["x"] + r0["w"]) * sc, (r0["y"] + r0["h"]) * sc
        check("자동 맞춤: 종이 위치·크기와 맞음",
              abs(bx0 - PAPER_BOX[0]) <= 40 and abs(by0 - PAPER_BOX[1]) <= 40
              and abs(bx1 - PAPER_BOX[2]) <= 40 and abs(by1 - PAPER_BOX[3]) <= 40,
              f"({bx0:.0f},{by0:.0f})-({bx1:.0f},{by1:.0f}) vs {PAPER_BOX}")
        check("자동 맞춤: 사진 전체보다 작게 잡음", r0["w"] * sc < 1200 * 0.95, str(r0))
        await page7.wait_for_timeout(2600)  # 앞선 토스트가 사라진 뒤 찍는다
        await page7.screenshot(path=os.path.join(SHOTS, "04_crop_modal_390.png"))
        check("04_crop_modal_390.png", os.path.getsize(os.path.join(SHOTS, "04_crop_modal_390.png")) > 20000)

        hb = await page7.locator("#cropFrame .crop-handle.br").bounding_box()
        await page7.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
        await page7.mouse.down()
        await page7.mouse.move(hb["x"] + hb["width"] / 2 - 100, hb["y"] + hb["height"] / 2 - 100, steps=10)
        await page7.mouse.up()
        await page7.wait_for_timeout(240)
        r_manual = await page7.evaluate("() => window.__receiptbox.crop.rect")
        check("손으로 줄인 뒤", r_manual["w"] < r0["w"] - 20, str(r_manual))
        await page7.click("#cropAuto")
        await page7.wait_for_timeout(320)
        r_auto = await page7.evaluate("() => window.__receiptbox.crop.rect")
        check("✨ 자동 맞춤을 다시 누르면 감지 영역으로 돌아옴",
              abs(r_auto["w"] - r0["w"]) <= 1.5 and abs(r_auto["h"] - r0["h"]) <= 1.5
              and abs(r_auto["x"] - r0["x"]) <= 1.5, f"{r_manual} → {r_auto}")

        # 회전한 뒤에도 자동 맞춤이 다시 동작
        await page7.click("#cropRotate")
        await page7.wait_for_timeout(420)
        st_rot = await page7.evaluate("() => window.__receiptbox.crop")
        check("회전 뒤 자동 맞춤이 다시 감지", st_rot["detected"] is not None, str(st_rot["detected"]))
        if st_rot["detected"]:
            d2 = st_rot["detected"]
            check("회전 뒤 감지 영역도 회전 반영", d2["w"] > d2["h"], str(d2))
        await page7.click("#cropCancel")
        await page7.wait_for_timeout(300)

        # 전체가 고른 색 — 감지 포기 → 전체 폴백
        await page7.set_input_files("#photoInput", [auto_flat])
        await page7.wait_for_selector("#cropWrap:not([hidden])")
        await page7.wait_for_timeout(400)
        st_flat = await page7.evaluate("() => window.__receiptbox.crop")
        check("균일한 사진은 감지하지 않음", st_flat["detected"] is None, str(st_flat["detected"]))
        view = await page7.locator("#cropView").bounding_box()
        rf = st_flat["rect"]
        check("감지 실패하면 사진 전체로 폴백",
              abs(rf["w"] - view["width"]) <= 1.5 and abs(rf["h"] - view["height"]) <= 1.5, str(rf))
        await page7.click("#cropAuto")
        await page7.wait_for_timeout(300)
        check("못 찾으면 안내 문구", "찾지 못해" in (await page7.inner_text("#toast")),
              await page7.inner_text("#toast"))
        check("폴백 상태에서도 모서리 조절 가능", await page7.locator(".crop-handle").count() == 4)
        await page7.click("#cropCancel")
        await page7.wait_for_timeout(250)
        await page7.click("#addClose")
        await page7.wait_for_timeout(250)
        ctx7.close()

        # ─────────────────────────────────────────────
        print("\n[10] 390 / 1280 레이아웃 · 스크린샷")
        ctx4, page4 = await new_page(browser, width=390, height=844, dsf=2)
        await goto(page4, port)
        await seed_items(page4, SEED)
        over = await page4.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390 첫 화면 가로 넘침 0", over <= 1, f"{over}px")
        cols = await page4.evaluate("getComputedStyle(document.getElementById('receiptGrid')).gridTemplateColumns")
        check("390 2열 그리드", len(cols.split(" ")) == 2, cols)
        await page4.wait_for_timeout(300)
        await page4.screenshot(path=os.path.join(SHOTS, "01_home_390.png"))
        check("01_home_390.png", os.path.getsize(os.path.join(SHOTS, "01_home_390.png")) > 20000)

        await form_open(page4)
        over = await page4.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390 등록 시트 가로 넘침 0", over <= 1, f"{over}px")
        await page4.fill("#fStore", "이마트 고양점 · 생필품")
        await page4.fill("#fAmount", "45300")
        await page4.click('#dueChips button[data-due="d7"]')
        await pick_photo(page4, receipt_a, "keep")
        await pick_photo(page4, product, "keep")
        check("02 화면 사진 2장", await page4.locator(".photo-cell").count() == 2)
        await page4.wait_for_timeout(250)
        await page4.screenshot(path=os.path.join(SHOTS, "02_add_390.png"))
        check("02_add_390.png", os.path.getsize(os.path.join(SHOTS, "02_add_390.png")) > 20000)
        await page4.click("#addClose")
        await page4.wait_for_timeout(220)

        await open_detail(page4, "seed-e1")
        over = await page4.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390 상세 가로 넘침 0", over <= 1, f"{over}px")
        await page4.wait_for_timeout(200)
        await page4.screenshot(path=os.path.join(SHOTS, "03_detail_390.png"))
        check("03_detail_390.png", os.path.getsize(os.path.join(SHOTS, "03_detail_390.png")) > 20000)

        sizes = await page4.evaluate("""() => {
            return Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
              id: el.id || el.type || el.tagName,
              size: parseFloat(getComputedStyle(el).fontSize)
            }));
        }""")
        bad = [s for s in sizes if s["size"] < 16]
        check("모든 input font-size >= 16px", len(bad) == 0, str(bad[:5]))
        check("입력 칸 개수 확인", len(sizes) >= 6, str(len(sizes)))
        await page4.click("#zoomClose") if await page4.is_visible("#zoomWrap") else None
        await page4.click("#detailClose")
        await page4.wait_for_timeout(180)

        over = await page4.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390 상세 닫은 뒤 가로 넘침 0", over <= 1, f"{over}px")
        ovx = await page4.evaluate("[getComputedStyle(document.documentElement).overflowX, getComputedStyle(document.body).overflowX]")
        check("html·body overflow-x 잠금", all(v in ("hidden", "clip") for v in ovx), str(ovx))
        osy = await page4.evaluate("[getComputedStyle(document.documentElement).overscrollBehaviorY, getComputedStyle(document.body).overscrollBehaviorY]")
        check("overscroll-behavior-y contain", all(v == "contain" for v in osy), str(osy))
        await ctx4.close()

        ctx5, page5 = await new_page(browser, width=1280, height=900)
        await goto(page5, port)
        await seed_items(page5, SEED)
        await page5.wait_for_timeout(250)
        over = await page5.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("1280 가로 넘침 0", over <= 1, f"{over}px")
        cols = await page5.evaluate("getComputedStyle(document.getElementById('receiptGrid')).gridTemplateColumns")
        check("1280에서도 2열 유지", len(cols.split(" ")) == 2, cols)
        width = await page5.evaluate("document.getElementById('app').getBoundingClientRect().width")
        check("1280에서 본문 폭 제한(<=640)", width <= 641, f"{width}px")
        await page5.click("#addCard")
        await page5.wait_for_selector("#addWrap:not([hidden])")
        await page5.wait_for_timeout(220)
        over = await page5.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("1280 등록 시트 가로 넘침 0", over <= 1, f"{over}px")
        await page5.click("#addClose")
        await ctx5.close()

        # ─────────────────────────────────────────────
        print("\n[11] 오프라인 실행")
        ctx6, page6 = await new_page(browser)
        await goto(page6, port)
        await seed_items(page6, SEED)
        try:
            active = await asyncio.wait_for(
                page6.evaluate("navigator.serviceWorker.ready.then(r => !!(r && r.active))"), 20)
            check("서비스워커 활성화", bool(active))
            await page6.wait_for_timeout(800)
            await ctx6.set_offline(True)
            await page6.reload(wait_until="domcontentloaded")
            await page6.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=12000)
            check("오프라인에서도 앱이 열림", True)
            check("오프라인에서도 4개", await page6.locator(".receipt").count() == 4,
                  f"{await page6.locator('.receipt').count()}개")
            check("오프라인에서도 요약", (await page6.inner_text("#sumMonth")) == won(MONTH_SUM))
        except Exception as exc:
            check("오프라인 실행", False, str(exc))
        finally:
            try:
                await ctx6.set_offline(False)
            except Exception:
                pass
            await ctx6.close()

        await browser.close()
    srv.shutdown()

    # ─────────────────────────────────────────────
    print("\n[12] 외부 전송 · 콘솔 오류")
    check("외부 서버로 보내는 요청 0", len(EXTERNAL) == 0, " | ".join(EXTERNAL[:3]))
    real_errors = [e for e in ERRORS if "favicon" not in e.lower()]
    check("콘솔 오류 0", len(real_errors) == 0, " | ".join(real_errors[:4]))

    print("\n" + "─" * 58)
    print(f"통과 {len(PASS)} · 실패 {len(FAIL)} · 경고 {len(WARN)}")
    if WARN:
        for w in WARN:
            print("  ! ", w)
    if FAIL:
        print("\n실패 항목:")
        for f in FAIL:
            print("  ✗ ", f)
        sys.exit(1)
    print("🎉 모든 검증 통과!")
    print("스크린샷:", SHOTS)


if __name__ == "__main__":
    asyncio.run(run())
