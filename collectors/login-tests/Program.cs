using System.Net;
using System.Text.Json;

int assertions = 0;
void Check(bool value, string message) { if (!value) throw new Exception(message); assertions++; }
void Fails(Action action, string code)
{
    try { action(); } catch (LoginFailure error) { Check(error.Code == code, "Wrong safe error code"); return; }
    throw new Exception("Expected failure: " + code);
}
Check(LoginProtocol.AllowedQr("bilibili", "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=fixture"), "Current Bilibili QR host");
Check(LoginProtocol.AllowedQr("bilibili", "https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=fixture"), "Legacy official Bilibili QR host");
Check(LoginProtocol.AllowedQr("netease", "https://music.163.com/login?codekey=fixture"), "NetEase QR host");
foreach (string url in new[] {
    "http://music.163.com/login", "https://music.163.com.evil.example/login", "https://evil.example/login",
    "https://music.163.com@evil.example/login", "https://user@music.163.com/login", "https://music.163.com:8443/login",
    "https://music.163.com/login#secret", "https://music.163.com/logout", "javascript:alert(1)", "file:///login"
}) Check(!LoginProtocol.AllowedQr("netease", url), "Reject misleading QR destination");
Check(!LoginProtocol.AllowedQr("other", "https://music.163.com/login"), "Unknown provider");
Check(!LoginProtocol.AllowedQr("bilibili", "https://music.163.com/login"), "Provider boundaries");

var jar = new CookieContainer();
jar.Add(new Cookie("SESSDATA", "fixture-session", "/", ".bilibili.com"));
jar.Add(new Cookie("bili_jct", "fixture-csrf", "/", ".bilibili.com"));
jar.Add(new Cookie("unnecessary", "discard", "/", ".bilibili.com"));
jar.Add(new Cookie("MUSIC_U", "fixture-music", "/", ".music.163.com"));
Check(LoginProtocol.CookieHeader(jar, "bilibili") == "SESSDATA=fixture-session; bili_jct=fixture-csrf", "Only necessary provider cookies");
Check(LoginProtocol.CookieHeader(jar, "netease") == "MUSIC_U=fixture-music", "Separate provider sessions");
var foreign = new CookieContainer(); foreign.Add(new Cookie("SESSDATA", "fixture-session", "/", ".bilibili.com.evil.example"));
Fails(() => LoginProtocol.CookieHeader(foreign, "bilibili"), "SESSION_NOT_RETURNED");
var expired = new CookieContainer(); expired.Add(new Cookie("MUSIC_U", "fixture", "/", ".music.163.com") { Expires = DateTime.UtcNow.AddDays(-1) });
Fails(() => LoginProtocol.CookieHeader(expired, "netease"), "SESSION_NOT_RETURNED");
Fails(() => LoginProtocol.CookieHeader(new CookieContainer(), "bilibili"), "SESSION_NOT_RETURNED");
Fails(() => LoginProtocol.Weapi(new { uid = "42" }, "short"), "INVALID_CRYPTO_KEY");

using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "vectors.json")));
var fixture = vectors.RootElement;
var payload = new Dictionary<string, object> { ["uid"] = "42", ["type"] = 1, ["csrf_token"] = "fixture" };
var weapi = LoginProtocol.Weapi(payload, "abcdefghijklmnop");
Check(weapi["params"] == fixture.GetProperty("weapi").GetProperty("params").GetString(), "WEAPI AES compatible with Node crypto");
Check(weapi["encSecKey"] == fixture.GetProperty("weapi").GetProperty("encSecKey").GetString(), "WEAPI RSA compatible with public-key implementation");
Check(LoginProtocol.Eapi("/api/login/qrcode/unikey", payload)["params"] == fixture.GetProperty("eapi").GetProperty("params").GetString(), "EAPI digest and AES compatible with Node crypto");
Console.WriteLine($"PASS: {assertions} login security and protocol assertions; fixtures contain no account data");
