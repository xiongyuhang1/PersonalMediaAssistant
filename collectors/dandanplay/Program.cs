using LiteDB;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using JsonSerializer = System.Text.Json.JsonSerializer;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PersonalMediaAssistant/collector/v1");
    private static string Argument(string[] args, string name, string fallback) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback; }
    private static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string Fingerprint(string path)
    {
        if (!File.Exists(path)) return "missing";
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return Convert.ToHexString(SHA256.HashData(input));
    }
    private static string Id(BsonDocument item, string field) => item[field].IsNumber ? item[field].AsInt64.ToString(System.Globalization.CultureInfo.InvariantCulture) : item[field].IsString ? item[field].AsString : "";
    private static string AnimeId(BsonDocument item) { var id = Id(item, "AnimeId64"); return id is "" or "0" ? Id(item, "AnimeId") : id; }
    private static string Text(BsonDocument item, string field, int limit = 600) { var value = item[field].IsString ? item[field].AsString : ""; return value.Length > limit ? value[..limit] : value; }
    private static string? Date(BsonValue value) => value.IsDateTime && value.AsDateTime.Year > 1970 && value.AsDateTime.Year < 2100 ? value.AsDateTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") : null;
    private static double? Number(BsonValue value) => value.IsNumber && double.IsFinite(value.AsDouble) && value.AsDouble >= 0 ? value.AsDouble : null;
    private static List<JsonObject> Read(string root)
    {
        string main = Path.Combine(root, "Cache", "dandanplay.litedb"), log = Path.Combine(root, "Cache", "dandanplay-log.litedb");
        if (!File.Exists(main)) throw new InvalidOperationException("SOURCE_NOT_FOUND");
        for (int attempt = 0; attempt < 3; attempt++)
        {
            string before = Fingerprint(main) + Fingerprint(log);
            string snapshotParent = Path.Combine(Path.GetTempPath(), "PmaDandanReadSnapshots");
            string snapshot = Path.Combine(snapshotParent, "snapshot_" + Guid.NewGuid().ToString("N"));
            string copy = Path.Combine(snapshot, "Cache"); Directory.CreateDirectory(copy);
            try
            {
            // Source handles are always read-only. Recover the active WAL only
            // inside a disposable private copy, never against the player's files.
            foreach (string file in new[] { main, log }) if (File.Exists(file))
            {
                using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var output = new FileStream(Path.Combine(copy, Path.GetFileName(file)), FileMode.CreateNew, FileAccess.Write, FileShare.None);
                input.CopyTo(output);
            }
            if (before != Fingerprint(main) + Fingerprint(log)) continue;
            var records = new List<JsonObject>();
            using (var db = new LiteDatabase(new ConnectionString { Filename = Path.Combine(copy, "dandanplay.litedb"), ReadOnly = false }))
            {
                var histories = db.GetCollection("bangumihistories").FindAll().ToList();
                var users = histories.Select(item => Id(item, "UserId")).Where(v => v.Length > 0).Distinct().ToList();
                if (users.Count != 1) throw new InvalidOperationException("ACCOUNT_SCOPE_AMBIGUOUS");
                string user = users[0];
                var titles = db.GetCollection("bangumis").FindAll().GroupBy(AnimeId).ToDictionary(g => g.Key, g => g.First());
                foreach (var item in histories)
                {
                    string id = AnimeId(item); if (id is "" or "0" || !titles.TryGetValue(id, out var work)) continue;
                    var row = Base("anime:" + id, id, "watchlist", Text(work, "AnimeTitle"), "collection_state");
                    BangumiMapping.Apply(item, work, row);
                    records.Add(row);
                }
                var episodes = new Dictionary<string, JsonObject>();
                foreach (var item in db.GetCollection("bangumiepisodehistories").FindAll())
                {
                    if (Id(item, "UserId") != user || !item["Episodes"].IsArray) continue;
                    string anime = AnimeId(item); if (anime is "" or "0") continue;
                    foreach (var value in item["Episodes"].AsArray)
                    {
                        if (!value.IsDocument) continue; var episode = value.AsDocument;
                        string? watched = Date(episode["LastWatched"]); if (watched is null) continue;
                        string id = Id(episode, "EpisodeId"); if (id is "" or "0") continue;
                        var row = Base(anime + ":" + id, id, "episodes", Text(episode, "EpisodeTitle"), "last_watch_observation");
                        row["parent_id"] = anime; row["episode_id"] = id; row["last_watched_at"] = watched;
                        row["source_time"] = watched; row["source_time_semantics"] = "last_watch";
                        episodes[anime + ":" + id] = row;
                    }
                }
                var library = db.GetCollection("libraryfiles").FindAll().Where(item => item["Path"].IsString).GroupBy(item => item["Path"].AsString, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
                foreach (var play in db.GetCollection("recentplays").FindAll())
                {
                    if (!play["FilePath"].IsString || !library.TryGetValue(play["FilePath"].AsString, out var file)) continue;
                    string anime = AnimeId(file), id = Id(file, "EpisodeId"); string? last = Date(play["LastPlay"]);
                    if (anime is "" or "0" || id is "" or "0" || last is null) continue;
                    string key = anime + ":" + id;
                    if (!episodes.TryGetValue(key, out var row)) { row = Base(key, id, "episodes", Text(file, "EpisodeTitle"), "last_play_observation"); row["parent_id"] = anime; row["episode_id"] = id; row["source_time"] = last; row["source_time_semantics"] = "last_play"; episodes[key] = row; }
                    if (row["last_local_play_at"] is JsonValue old && string.CompareOrdinal(old.GetValue<string>(), last) > 0) continue;
                    row["last_local_play_at"] = last;
                    double? position = Number(play["ExitTime"]); if (position.HasValue) { row["resume_position_raw"] = position; row["resume_unit"] = "unknown"; }
                }
                records.AddRange(episodes.Values);
            }
            if (before == Fingerprint(main) + Fingerprint(log)) return records.OrderBy(row => row["id"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
            }
            finally
            {
                string target = Path.GetFullPath(snapshot), parent = Path.GetFullPath(snapshotParent);
                if (Path.GetDirectoryName(target) != parent || !Path.GetFileName(target).StartsWith("snapshot_", StringComparison.Ordinal) || (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("UNSAFE_SNAPSHOT_CLEANUP");
                Directory.Delete(target, true);
            }
            Thread.Sleep(500);
        }
        throw new InvalidOperationException("SOURCE_CHANGED_DURING_READ");
    }
    private static JsonObject Base(string id, string content, string dataset, string title, string kind) => new() { ["id"] = id, ["content_id"] = content, ["platform"] = "dandanplay", ["dataset"] = dataset, ["title"] = string.IsNullOrWhiteSpace(title) ? "分集 " + content : title, ["record_kind"] = kind, ["collected_at"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") };
    private static string RecordDigest(JsonObject row) { var clone = row.DeepClone().AsObject(); clone.Remove("collected_at"); return Digest(clone.ToJsonString(JsonOptions)); }
    private static void AtomicWrite(string path, string content) { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!); File.WriteAllText(path + ".tmp", content, new UTF8Encoding(false)); File.Move(path + ".tmp", path, true); }
    private static void Setup(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("WINDOWS_REQUIRED");
        Console.WriteLine("READY_FOR_CREDENTIALS (input hidden)");
        string input;
        if (Console.IsInputRedirected) input = Console.ReadLine() ?? "";
        else { var text = new StringBuilder(); while (true) { var key = Console.ReadKey(true); if (key.Key == ConsoleKey.Enter || key.KeyChar == '\n') break; if (key.Key == ConsoleKey.Backspace) { if (text.Length > 0) text.Length--; } else text.Append(key.KeyChar); } input = text.ToString(); }
        var data = JsonNode.Parse(input)?.AsObject() ?? throw new InvalidOperationException("INVALID_CREDENTIALS");
        if (!Uri.TryCreate(data["endpoint"]?.GetValue<string>(), UriKind.Absolute, out var endpoint) || endpoint.Scheme != "https" || endpoint.UserInfo.Length > 0 || endpoint.Query.Length > 0) throw new InvalidOperationException("HTTPS_ENDPOINT_REQUIRED");
        if ((data["ingest_token"]?.GetValue<string>().Length ?? 0) < 32 || string.IsNullOrEmpty(data["sites_token"]?.GetValue<string>())) throw new InvalidOperationException("INVALID_CREDENTIALS");
        byte[] clear = Encoding.UTF8.GetBytes(data.ToJsonString());
        try { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!); File.WriteAllBytes(path, ProtectedData.Protect(clear, Entropy, DataProtectionScope.CurrentUser)); }
        finally { CryptographicOperations.ZeroMemory(clear); }
        Console.WriteLine("CREDENTIALS_SAVED_WITH_WINDOWS_DPAPI");
    }
    private static JsonObject Credentials(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("WINDOWS_REQUIRED");
        byte[] clear = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
        try { return JsonNode.Parse(clear)?.AsObject() ?? throw new InvalidOperationException("INVALID_CREDENTIALS"); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }
    private static async Task Sync(string source, string stateRoot, JsonObject credentials)
    {
        Directory.CreateDirectory(stateRoot); string checkpointPath = Path.Combine(stateRoot, "checkpoint.json"); string outbox = Path.Combine(stateRoot, "outbox"); Directory.CreateDirectory(outbox);
        using var handler = new HttpClientHandler { AllowAutoRedirect = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(40) };
        var (heartbeatSupported, heartbeatAck) = await Heartbeat(client, credentials);
        string epochPath = Path.Combine(stateRoot, "sync-epoch.txt");
        var control = CollectorControl.Read(heartbeatAck?["collector_control"], File.Exists(epochPath) ? File.ReadAllText(epochPath) : null);
        if (control.Paused) { Console.WriteLine(JsonSerializer.Serialize(new { status = "paused_by_owner", source_read = false, pending_batches = Directory.GetFiles(outbox, "*.json").Length })); return; }
        if (control.ResetCheckpoint)
        {
            // Only this collector's checkpoint/outbox are reset. The player's
            // source database is never modified, including after cloud deletion.
            AtomicWrite(checkpointPath, "{}");
            foreach (string file in Directory.GetFiles(outbox, "*.json")) File.Delete(file);
            string oldMarker = Path.Combine(stateRoot, "source-marker.txt"); if (File.Exists(oldMarker)) File.Delete(oldMarker);
        }
        AtomicWrite(epochPath, control.Epoch);
        var checkpoint = File.Exists(checkpointPath) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(checkpointPath))! : new();
        var queued = new HashSet<string>();
        foreach (string file in Directory.GetFiles(outbox, "*.json")) foreach (var item in JsonNode.Parse(File.ReadAllText(file))!["items"]!.AsArray()) if (item is JsonObject row) queued.Add(row["dataset"]!.GetValue<string>() + ":" + row["id"]!.GetValue<string>() + ":" + RecordDigest(row));
        string markerPath = Path.Combine(stateRoot, "source-marker.txt");
        string sourceMarker = BangumiMapping.Version + ":" + Fingerprint(Path.Combine(source, "Cache", "dandanplay.litedb")) + Fingerprint(Path.Combine(source, "Cache", "dandanplay-log.litedb"));
        bool unchanged = File.Exists(markerPath) && File.ReadAllText(markerPath) == sourceMarker && queued.Count == 0;
        var changed = (unchanged ? new List<JsonObject>() : Read(source)).Where(row => { string key = row["dataset"]!.GetValue<string>() + ":" + row["id"]!.GetValue<string>(); string digest = RecordDigest(row); return (!checkpoint.TryGetValue(key, out string? old) || old != digest) && !queued.Contains(key + ":" + digest); }).ToList();
        foreach (var chunk in changed.Chunk(25))
        {
            string batch = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + "_" + Guid.NewGuid().ToString("N");
            var items = new JsonArray(chunk.Select(row => (JsonNode)row.DeepClone()).ToArray());
            var payload = new JsonObject { ["schema_version"] = "1.0", ["device_id"] = credentials["device_id"]!.GetValue<string>(), ["batch_id"] = batch, ["items"] = items };
            AtomicWrite(Path.Combine(outbox, batch + ".json"), payload.ToJsonString(JsonOptions));
        }
        int sent = 0;
        foreach (string file in Directory.GetFiles(outbox, "*.json").Order(StringComparer.Ordinal))
        {
            string body = File.ReadAllText(file); using var request = new HttpRequestMessage(HttpMethod.Post, credentials["endpoint"]!.GetValue<string>());
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials["ingest_token"]!.GetValue<string>());
            request.Headers.TryAddWithoutValidation("OAI-Sites-Authorization", "Bearer " + credentials["sites_token"]!.GetValue<string>());
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("SYNC_HTTP_" + (int)response.StatusCode);
            var ack = JsonNode.Parse(await response.Content.ReadAsStringAsync()); if (ack?["accepted"]?.GetValue<bool>() != true) throw new InvalidOperationException("SYNC_NOT_ACKNOWLEDGED");
            foreach (var value in JsonNode.Parse(body)!["items"]!.AsArray()) { var row = value!.AsObject(); checkpoint[row["dataset"]!.GetValue<string>() + ":" + row["id"]!.GetValue<string>()] = RecordDigest(row); sent++; }
            AtomicWrite(checkpointPath, JsonSerializer.Serialize(checkpoint, JsonOptions)); File.Delete(file);
        }
        AtomicWrite(markerPath, sourceMarker);
        Console.WriteLine(JsonSerializer.Serialize(new { status = "synced", records_acknowledged = sent, pending_batches = Directory.GetFiles(outbox, "*.json").Length, source_unchanged = unchanged, heartbeat_supported = heartbeatSupported, checkpoint_reset = control.ResetCheckpoint, netease_crypto_runtime_ready = heartbeatAck?["netease_crypto_runtime_ready"]?.GetValue<bool>(), completed_at = DateTimeOffset.UtcNow }));
    }
    private static async Task<(bool Supported, JsonNode? Ack)> Heartbeat(HttpClient client, JsonObject credentials)
    {
        using var heartbeat = new HttpRequestMessage(HttpMethod.Post, credentials["endpoint"]!.GetValue<string>());
        heartbeat.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials["ingest_token"]!.GetValue<string>());
        heartbeat.Headers.TryAddWithoutValidation("OAI-Sites-Authorization", "Bearer " + credentials["sites_token"]!.GetValue<string>());
        heartbeat.Content = new StringContent(new JsonObject { ["schema_version"] = "1.0", ["device_id"] = credentials["device_id"]!.GetValue<string>(), ["heartbeat"] = true }.ToJsonString(), Encoding.UTF8, "application/json");
        using var heartbeatResponse = await client.SendAsync(heartbeat);
        string heartbeatBody = await heartbeatResponse.Content.ReadAsStringAsync();
        JsonNode? heartbeatAck = null;
        try { if (heartbeatBody.Length < 4096) heartbeatAck = JsonNode.Parse(heartbeatBody); } catch (JsonException) { }
        bool heartbeatSupported = heartbeatResponse.IsSuccessStatusCode;
        bool legacyServer = (int)heartbeatResponse.StatusCode == 400 && heartbeatAck?["code"]?.GetValue<string>() == "INVALID_BATCH";
        if (!heartbeatSupported && !legacyServer) throw new InvalidOperationException("HEARTBEAT_HTTP_" + (int)heartbeatResponse.StatusCode);
        if (heartbeatSupported && heartbeatAck?["accepted"]?.GetValue<bool>() != true) throw new InvalidOperationException("HEARTBEAT_NOT_ACKNOWLEDGED");
        return (heartbeatSupported, heartbeatAck);
    }
    public static async Task<int> Main(string[] args)
    {
        string mode = args.FirstOrDefault() ?? "help";
        string source = Argument(args, "--source", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "弹弹play"));
        string state = Path.GetFullPath(Argument(args, "--state", ".local/dandanplay")); string credentialsPath = Path.GetFullPath(Argument(args, "--credentials", ".local/dandanplay.dpapi"));
        try
        {
            if (mode == "setup") { Setup(credentialsPath); return 0; }
            if (mode == "snapshot") { var rows = Read(source); string output = Argument(args, "--out", Path.Combine(state, "snapshot.json")); AtomicWrite(output, new JsonObject { ["schema_version"] = "1.0", ["exported_at"] = DateTimeOffset.UtcNow.ToString("o"), ["records"] = new JsonArray(rows.Select(row => (JsonNode)row).ToArray()) }.ToJsonString(JsonOptions)); Console.WriteLine(JsonSerializer.Serialize(new { status = "snapshot_ready", records = rows.Count, source_read_only = true })); return 0; }
            if (mode is not ("sync" or "watch")) { Console.WriteLine("Commands: setup | snapshot | sync | watch; --source --state --credentials --out"); return 0; }
            Directory.CreateDirectory(state); using var gate = new FileStream(Path.Combine(state, "collector.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            var credentials = Credentials(credentialsPath);
            do { try { await Sync(source, state, credentials); } catch (Exception error) { Console.WriteLine(JsonSerializer.Serialize(new { status = "retry_pending", code = error is InvalidOperationException ? error.Message : "COLLECTOR_ERROR" })); if (mode == "sync") return 1; } if (mode != "watch") break; await Task.Delay(TimeSpan.FromSeconds(300)); } while (true);
            return 0;
        }
        catch (Exception error) { Console.WriteLine(JsonSerializer.Serialize(new { status = "failed", code = error is InvalidOperationException ? error.Message : "COLLECTOR_ERROR", error_type = error.GetType().Name, operation = error.TargetSite?.Name, frames = args.Contains("--diagnostics") ? new System.Diagnostics.StackTrace(error).GetFrames().Select(frame => frame.GetMethod()?.DeclaringType?.Name + "." + frame.GetMethod()?.Name).ToArray() : null })); return 1; }
    }
}
