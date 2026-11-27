# 영수증함 (receipt-box)

종이 영수증을 찍어 담아 두고, 교환·환불 기한과 경비 정산을 놓치지 않게 챙겨 주는 혼자 쓰는 PWA.

- **내 폰에만 저장** — 서버·Firebase 없음. IndexedDB(안 되면 localStorage) + JSON 백업/복원
- **첫 화면 2열 사진 그리드** — 첫 칸 `＋ 영수증 사진등록`, 그 뒤로 사진 썸네일 + 가게명 + 금액 + 용도/D-day 배지
- **상단 요약** — 이번 달 합계(금액 · 건수), 미처리 건수(보관용 제외)
- **보관 중 / 처리완료** 탭 분리, 처리완료는 되돌리기 가능
- **용도 태그** — 교환·환불 / 경비·정산 / AS·보증 / 보관용. 교환·환불은 구매일에서 `7일·14일·30일` 빠른 마감일, AS·보증은 `1년·2년`
- **사진 2장까지**(긴 영수증 + 물건 사진), 상세에서 흰 바탕 크게 보기, 가게명·금액·메모 검색
- **아이폰 화면 고정** — 확대 금지, input 16px 이상, 가로 넘침 없음

## 파일

| 파일 | 내용 |
|---|---|
| `index.html` | 화면 마크업 |
| `styles.css` | 토스 스타일 |
| `app.js` | 저장·D-day·검색·백업 |
| `sw.js` | 오프라인 캐시 `receipt-box-v1` |
| `manifest.webmanifest` | PWA 설정 |
| `icon-180.png` `icon-192.png` `icon-512.png` | 꽉 찬 정사각형 아이콘 |
| `make_icons.py` | 아이콘 다시 만들기 |
| `test_app.py` | 자동 검증 (플레이라이트) |

## 배포

`main` 브랜치 → GitHub Pages (`/ (root)`) → `https://bswjys.github.io/receipt-box/`
아이폰 사파리에서 열고 **홈 화면에 추가**하면 앱처럼 쓴다.

## 데이터

- IndexedDB `receipt-box` / 스토어 `receipts` (실패 시 localStorage `receiptbox.v1`)
- 백업 파일 이름 `receipt-box-backup-YYYY-MM-DD.json`
- 사진은 긴 변 1800px JPEG(q 0.84)로 줄여 저장
