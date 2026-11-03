// Protocol adaptations: Bilibili QR-login portions reference XZXZZX-Ai/bilibili-mcp
// v1.14.6 under Apache-2.0 (vendor/bilibili-mcp.LICENSE). Modified here: C# port,
// fixed-host HTTP requests, bounded polling, and credential-field allowlists.
// NetEase portions reference api-enhanced under MIT (vendor/netease-api.LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root; upstream terms are retained.
using System.Net;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed class LoginFailure(string code) : Exception(code) { public string Code { get; } = code; }
internal static class LoginProtocol
{
    public static bool AllowedQr(string provider, string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length != 0 || !uri.IsDefaultPort || uri.Fragment.Length != 0) return false;
        return provider == "bilibili" ? (uri.Host == "account.bilibili.com" && uri.AbsolutePath == "/h5/account-h5/auth/scan-web") || (uri.Host == "passport.bilibili.com" && uri.AbsolutePath == "/h5-app/passport/login/scan") : provider == "netease" && uri.Host == "music.163.com" && uri.AbsolutePath == "/login";
    }
    public static string CookieHeader(CookieContainer jar, string provider)
    {
        string[] allowed = provider == "bilibili" ? ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4"] : ["MUSIC_U", "__csrf", "NMTID", "__remember_me", "os", "appver", "deviceId"];
        string domain = provider == "bilibili" ? "bilibili.com" : "music.163.com";
        var cookies = jar.GetAllCookies().Cast<Cookie>().Where(c => allowed.Contains(c.Name) && (c.Domain.TrimStart('.') == domain || c.Domain.TrimStart('.').EndsWith("." + domain, StringComparison.OrdinalIgnoreCase)) && !c.Expired).GroupBy(c => c.Name).Select(g => g.First()).ToList();
        if (!cookies.Any(c => c.Name == (provider == "bilibili" ? "SESSDATA" : "MUSIC_U"))) throw new LoginFailure("SESSION_NOT_RETURNED");
        if (cookies.Any(c => !Regex.IsMatch(c.Value, @"^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$"))) throw new LoginFailure("INVALID_COOKIE");
        return string.Join("; ", cookies.OrderBy(c => c.Name, StringComparer.Ordinal).Select(c => c.Name + "=" + c.Value));
    }
    public static Dictionary<string, string> Weapi(object payload, string? key = null)
    {
        key ??= Convert.ToBase64String(RandomNumberGenerator.GetBytes(12));
        if (key.Length != 16) throw new LoginFailure("INVALID_CRYPTO_KEY");
        string first = Convert.ToBase64String(Aes(JsonSerializer.Serialize(payload), "0CoJUm6Qyw8W8jud", CipherMode.CBC));
        byte[] reversed = Encoding.UTF8.GetBytes(new string(key.Reverse().ToArray()));
        var modulus = BigInteger.Parse("00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7", System.Globalization.NumberStyles.HexNumber);
        string rsa = Convert.ToHexString(BigInteger.ModPow(new BigInteger(reversed, true, true), 65537, modulus).ToByteArray(true, true)).ToLowerInvariant().PadLeft(256, '0');
        return new() { ["params"] = Convert.ToBase64String(Aes(first, key, CipherMode.CBC)), ["encSecKey"] = rsa };
    }
    public static Dictionary<string, string> Eapi(string path, object payload)
    {
        string text = JsonSerializer.Serialize(payload);
        string digest = Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes("nobody" + path + "use" + text + "md5forencrypt"))).ToLowerInvariant();
        return new() { ["params"] = Convert.ToHexString(Aes(path + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest, "e82ckenh8dichen8", CipherMode.ECB)) };
    }
    private static byte[] Aes(string text, string key, CipherMode mode)
    {
        using var aes = System.Security.Cryptography.Aes.Create(); aes.Key = Encoding.UTF8.GetBytes(key); aes.Mode = mode; aes.Padding = PaddingMode.PKCS7;
        if (mode == CipherMode.CBC) aes.IV = Encoding.UTF8.GetBytes("0102030405060708");
        return aes.EncryptEcbOrCbc(Encoding.UTF8.GetBytes(text), mode);
    }
    private static byte[] EncryptEcbOrCbc(this Aes aes, byte[] bytes, CipherMode mode) => mode == CipherMode.ECB ? aes.EncryptEcb(bytes, PaddingMode.PKCS7) : aes.EncryptCbc(bytes, aes.IV, PaddingMode.PKCS7);
}

internal sealed class PlatformLogin(string provider) : IDisposable
{
    public CookieContainer Jar { get; } = new();
    private HttpClient? client;
    private string key = "";
    private string Provider => provider;
    private HttpClient Client => client ??= CreateClient();
    private HttpClient CreateClient()
    {
        var result = new HttpClient(new HttpClientHandler { CookieContainer = Jar, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(15), MaxResponseContentBufferSize = 65536 };
        result.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36");
        if (Provider == "netease") { Jar.Add(new Cookie("os", "pc", "/", ".music.163.com")); Jar.Add(new Cookie("appver", "3.1.17.204416", "/", ".music.163.com")); Jar.Add(new Cookie("deviceId", Guid.NewGuid().ToString("N"), "/", ".music.163.com")); }
        return result;
    }
    private async Task<JsonElement> Json(string url, Dictionary<string, string>? form, CancellationToken token)
    {
        using var request = new HttpRequestMessage(form is null ? HttpMethod.Get : HttpMethod.Post, url);
        request.Headers.Referrer = new Uri(Provider == "bilibili" ? "https://www.bilibili.com/" : "https://music.163.com/");
        if (form is not null) request.Content = new FormUrlEncodedContent(form);
        using var response = await Client.SendAsync(request, token);
        if (!response.IsSuccessStatusCode) throw new LoginFailure("HTTP_" + (int)response.StatusCode);
        string body = await response.Content.ReadAsStringAsync(token); if (body.Length > 65536) throw new LoginFailure("RESPONSE_TOO_LARGE");
        using var document = JsonDocument.Parse(body); return document.RootElement.Clone();
    }
    private async Task<JsonElement> Music(string path, Dictionary<string, object> data, bool weapi, CancellationToken token)
    {
        data["e_r"] = false;
        var cookies = Jar.GetAllCookies().Cast<Cookie>().GroupBy(c => c.Name).ToDictionary(g => g.Key, g => g.First().Value);
        if (weapi) { data["csrf_token"] = cookies.GetValueOrDefault("__csrf", ""); return await Json("https://music.163.com/weapi/" + path[5..], LoginProtocol.Weapi(data), token); }
        data["header"] = new Dictionary<string, object> { ["os"] = "pc", ["appver"] = "3.1.17.204416", ["deviceId"] = cookies.GetValueOrDefault("deviceId", ""), ["requestId"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "_0001", ["__csrf"] = cookies.GetValueOrDefault("__csrf", ""), ["MUSIC_U"] = cookies.GetValueOrDefault("MUSIC_U", "") };
        return await Json("https://interfacepc.music.163.com/eapi/" + path[5..], LoginProtocol.Eapi(path, data), token);
    }
    public async Task<string> Generate(CancellationToken token)
    {
        if (Provider == "bilibili")
        {
            var result = await Json("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", null, token);
            if (result.GetProperty("code").GetInt32() != 0) throw new LoginFailure("QR_GENERATION_FAILED");
            var data = result.GetProperty("data"); key = data.GetProperty("qrcode_key").GetString() ?? "";
            string url = data.GetProperty("url").GetString() ?? "";
            if (!Regex.IsMatch(key, @"^[A-Za-z0-9_-]{1,256}$") || !LoginProtocol.AllowedQr(Provider, url)) throw new LoginFailure("INVALID_QR_RESPONSE");
            return url;
        }
        // Instantiate client before collecting device cookies.
        _ = Client;
        var music = await Music("/api/login/qrcode/unikey", new() { ["type"] = 3 }, false, token);
        if (music.GetProperty("code").GetInt32() != 200) throw new LoginFailure("QR_GENERATION_FAILED");
        key = music.GetProperty("unikey").GetString() ?? "";
        if (!Regex.IsMatch(key, @"^[A-Za-z0-9_-]{1,256}$")) throw new LoginFailure("INVALID_QR_RESPONSE");
        return "https://music.163.com/login?codekey=" + Uri.EscapeDataString(key);
    }
    public async Task<(string Status, Dictionary<string, string>? Entries)> Poll(CancellationToken token)
    {
        if (Provider == "bilibili")
        {
            var response = await Json("https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=" + Uri.EscapeDataString(key), null, token);
            if (response.GetProperty("code").GetInt32() != 0) throw new LoginFailure("QR_POLL_FAILED");
            int code = response.GetProperty("data").GetProperty("code").GetInt32();
            if (code == 86101) return ("等待使用B站App扫码", null);
            if (code == 86090) return ("已扫码，请在手机B站App确认登录", null);
            if (code == 86038) throw new LoginFailure("QR_EXPIRED");
            if (code != 0) throw new LoginFailure("QR_POLL_FAILED");
            // Obtain the provider-issued buvid, never fabricate one.
            try { var finger = await Json("https://api.bilibili.com/x/frontend/finger/spi", null, token); var data = finger.GetProperty("data"); foreach (var item in new[] { ("b_3", "buvid3"), ("b_4", "buvid4") }) if (data.TryGetProperty(item.Item1, out var value) && value.GetString() is string text && text.Length > 0) Jar.Add(new Cookie(item.Item2, text, "/", ".bilibili.com")); } catch (LoginFailure) { }
            string cookie = LoginProtocol.CookieHeader(Jar, Provider);
            var me = await Json("https://api.bilibili.com/x/web-interface/nav", null, token);
            if (me.GetProperty("code").GetInt32() != 0 || !me.GetProperty("data").GetProperty("isLogin").GetBoolean()) throw new LoginFailure("LOGIN_NOT_CONFIRMED");
            return ("B站登录验证成功", new() { ["BILIBILI_COOKIE"] = cookie });
        }
        var result = await Music("/api/login/qrcode/client/login", new() { ["key"] = key, ["type"] = 3 }, false, token);
        int status = result.GetProperty("code").GetInt32();
        if (status == 801) return ("等待使用网易云音乐App扫码", null);
        if (status == 802) return ("已扫码，请在手机网易云音乐App确认登录", null);
        if (status == 800) throw new LoginFailure("QR_EXPIRED");
        if (status != 803) throw new LoginFailure("QR_POLL_FAILED");
        string musicCookie = LoginProtocol.CookieHeader(Jar, Provider);
        var account = await Music("/api/nuser/account/get", new(), true, token);
        if (account.GetProperty("code").GetInt32() != 200 || !account.TryGetProperty("account", out var user) || user.ValueKind != JsonValueKind.Object || !user.TryGetProperty("id", out var id)) throw new LoginFailure("ACCOUNT_NOT_CONFIRMED");
        string uid = id.ValueKind == JsonValueKind.String ? id.GetString() ?? "" : id.GetRawText();
        if (!Regex.IsMatch(uid, @"^[1-9][0-9]{0,19}$")) throw new LoginFailure("INVALID_ACCOUNT_ID");
        return ("网易云登录验证成功", new() { ["NETEASE_COOKIE"] = musicCookie, ["NETEASE_UID"] = uid });
    }
    public void Dispose() { client?.Dispose(); }
}
