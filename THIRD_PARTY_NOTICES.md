# Third-party notices

The root MIT license applies to this project's original code. Bundled and adapted third-party code retains its original license and copyright notices; those notices take precedence for the relevant files. Package dependencies retain their respective upstream licenses.

| Component | Use | License locations |
| --- | --- | --- |
| [Bilibili-Agent-mcp](https://github.com/Gsxcheng/Bilibili-Agent-mcp) | Read-only HTTP/WBI subset and login protocol adaptation | `vendor/bilibili/LICENSE`, `apps/mcp-gateway/vendor/bilibili/LICENSE` (MIT) |
| [bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp) | Bilibili QR-login protocol portions adapted to C# | `collectors/login/vendor/bilibili-mcp.LICENSE` (Apache-2.0) |
| [netease-music-mcp](https://github.com/Vael-KY/netease-music-mcp) | Read-only NetEase request adaptation | `apps/mcp-gateway/vendor/netease-mcp/LICENSE` (MIT) |
| [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | Read-only NetEase routes and encryption adaptation | `apps/mcp-gateway/vendor/netease-api/LICENSE`, `collectors/login/vendor/netease-api.LICENSE` (MIT) |
| [LiteDB](https://github.com/litedb-org/LiteDB) | Local database reads | `collectors/dandanplay/vendor/LICENSE` (MIT) |
| [QRCoder](https://github.com/codebude/QRCoder) | Locally generated login QR codes | `collectors/login/vendor/QRCoder.LICENSE` (MIT) |
| [Zod](https://github.com/colinhacks/zod) | Schema validation | `collectors/bilibili/vendor/Zod.LICENSE` (MIT) |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | UI components and styles | `apps/mcp-gateway/vendor/shadcn-tailwind-4.13.0.LICENSE.md` (MIT) |

The application also uses React, Vinext, Vite, Cloudflare tooling, and other packages declared in the lockfiles. Install dependencies from their registries and preserve their supplied license notices when redistributing a built bundle. No media audio/video, private database, platform credential, or upstream research snapshot is included in this repository.
