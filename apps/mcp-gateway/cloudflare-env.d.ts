declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PMA_BACKEND_URL?: string;
    PMA_BACKEND_TOKEN?: string;
    PMA_CURSOR_KEY?: string;
    PMA_INGEST_TOKEN?: string;
    PMA_INGEST_DEVICE_ID?: string;
    STEAM_API_KEY?: string;
    STEAM_ID?: string;
    BILIBILI_COOKIE?: string;
    NETEASE_COOKIE?: string;
    NETEASE_UID?: string;
  }
}
