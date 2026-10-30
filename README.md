# Video Grabber

페이지에서 재생되는 영상을 찾아서 다운로드하는 Firefox 확장입니다.

- 직접 링크된 미디어 파일(mp4, webm, mov, mkv, mp3 등)을 그대로 저장합니다.
- 암호화되지 않은 HLS(`.m3u8`) 스트림은 화질을 골라 조각을 받아 하나의 `.mp4` 파일로 저장합니다. MPEG-TS 조각(H.264/AAC)은 [mux.js](https://github.com/videojs/mux.js)로 MP4로 변환하고, 변환할 수 없는 코덱(HEVC 등)이면 원본 `.ts`로 저장합니다.
- 파일 이름은 페이지의 영상 제목(`og:title` 등, 사이트 이름 제거)에서, 확장자는 파일 앞부분 바이트를 직접 확인해 정합니다. 저장 대화상자 없이 다운로드 폴더에 저장됩니다.

DRM이나 HLS 암호화(`EXT-X-KEY`)가 걸린 영상, YouTube처럼 MediaSource로 조각을 받아 재생하는 사이트는 지원하지 않습니다.

## 설치

[Releases](https://github.com/kharam1436/video-grabber/releases/latest)에서 `video-grabber-<버전>.xpi`를 받아 Firefox 창에 끌어다 놓으세요. Mozilla 서명(unlisted)을 받은 파일이라 일반 Firefox(142 이상)에 영구 설치되고, 이후 새 릴리스는 Firefox가 자동으로 업데이트합니다.

## 개발

```sh
npm ci
npm start        # 임시 프로필의 Firefox에서 확장을 띄움 (web-ext run)
npm test         # lib/formats.js 단위 테스트
npm run lint     # web-ext lint
npm run build    # 서명 안 된 zip (about:debugging 임시 로드용)
```

구조:

| 파일 | 역할 |
| --- | --- |
| `background.js` | 네트워크 응답으로 영상 감지, HLS 다운로드, 저장 |
| `lib/formats.js` | HLS 재생목록 파싱, 파일 형식 판별, 파일 이름 정리 (순수 함수, 테스트 대상) |
| `lib/remux.js` | MPEG-TS → MP4 변환 (mux.js 사용) |
| `vendor/mux-mp4.min.js` | mux.js 배포 파일 사본 (Apache-2.0). `npm run vendor`로 `node_modules`에서 갱신 |
| `content.js` | `<video>` 태그 탐색, 페이지의 영상 제목 추출 |
| `popup/` | 툴바 팝업 |

## 자동화 (GitHub Actions)

- **CI** (`ci.yml`): push/PR마다 문법 검사, 테스트, lint, 빌드를 돌리고 서명 안 된 zip을 아티팩트로 올립니다.
- **Release** (`release.yml`): `v*` 태그가 push되면 버전을 확인하고, addons.mozilla.org에서 unlisted 서명을 받아 `.xpi`와 `updates.json`을 GitHub Release로 올립니다.
- **Dependabot**: npm 패키지와 Actions 버전을 매달 확인합니다.

### 릴리스 하는 법

```sh
npm run release -- 1.0.2
```

`manifest.json` 버전을 올려 커밋하고, 태그를 만들어 push합니다. 나머지는 Release 워크플로가 처리합니다.

저장소 Secrets에 AMO API 키가 있어야 합니다 ([발급](https://addons.mozilla.org/developers/addon/api/key/)):

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`
