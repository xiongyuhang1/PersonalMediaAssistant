using LiteDB;
using System.Text.Json.Nodes;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
JsonObject Map(BsonDocument history, BsonDocument? work = null) { var row = new JsonObject(); BangumiMapping.Apply(history, work ?? new BsonDocument(), row); return row; }

var completed = Map(new BsonDocument { ["IsFavorited"] = true, ["FavoriteStatus"] = 1, ["EpisodeWatched"] = 0 });
Check(completed["completion_state"]!.GetValue<string>() == "completed" && completed["all_episodes_completed"]!.GetValue<bool>(), "Explicit status completes all episodes despite missing dates/counts");
Check(!completed.ContainsKey("source_time") && !completed.ContainsKey("last_watched_at"), "Never invent dates");
Check(Map(new BsonDocument { ["FavoriteStatus"] = 0 })["completion_state"]!.GetValue<string>() == "not_completed", "0 means not completed, not automatically watching");
Check(Map(new BsonDocument { ["FavoriteStatus"] = 2 })["completion_state"]!.GetValue<string>() == "abandoned", "2 means abandoned");
Check(Map(new BsonDocument { ["FavoriteStatus"] = 7 })["completion_state"]!.GetValue<string>() == "unknown", "Unknown enum must not imply completion");
Check(!Map(new BsonDocument()).ContainsKey("following"), "Missing flag is unknown, not false");
foreach (int value in new[] { 0, 6, 8, 9, 10 })
{
    var row = Map(new BsonDocument { ["Rating"] = 9.5 }, new BsonDocument { ["UserRating"] = value, ["Rating"] = 7.3 });
    Check(row["user_rating_state"]!.GetValue<string>() == (value == 0 ? "unrated" : "rated"), "Zero means unrated");
    Check(value == 0 ? row["user_rating"] is null : row["user_rating"]!.GetValue<double>() == value, "Personal score comes from UserRating");
    Check(row["community_rating"]!.GetValue<double>() == 7.3, "Community score stays separate");
}
var comment = Map(new BsonDocument { ["Comment"] = new string('x', 999) + "😀tail" });
Check(comment["user_comment"]!.GetValue<string>().Length == 999 && comment["user_comment_truncated"]!.GetValue<bool>(), "Comments respect output limit without splitting surrogate pairs");
Console.WriteLine("PASS: explicit completion, unknown/missing status, personal scores, zero unrated, no fake dates, bounded comments");
var initialControl = JsonNode.Parse("{\"sync_paused\":false,\"sync_epoch\":\"initial\"}");
Check(!CollectorControl.Read(initialControl, null).ResetCheckpoint, "Upgrade does not re-upload unchanged source");
string epoch = Guid.NewGuid().ToString("D");
var resumed = new JsonObject { ["sync_paused"] = false, ["sync_epoch"] = epoch };
Check(CollectorControl.Read(resumed, "initial").ResetCheckpoint, "Resume after deletion requires a full re-upload");
Check(!CollectorControl.Read(resumed, epoch).ResetCheckpoint, "Same epoch keeps incremental checkpoint");
resumed["sync_paused"] = true;
Check(CollectorControl.Read(resumed, "initial").Paused && !CollectorControl.Read(resumed, "initial").ResetCheckpoint, "Paused collector must not inspect or upload source");
Check(!CollectorControl.Read(null, "initial").ResetCheckpoint, "Legacy heartbeat remains compatible");
bool rejected = false;
try { CollectorControl.Read(JsonNode.Parse("{\"sync_paused\":false,\"sync_epoch\":\"untrusted-invalid\"}"), null); } catch (InvalidOperationException) { rejected = true; }
Check(rejected, "Malformed controls must not clear checkpoints");
Console.WriteLine("PASS: pause, resume epoch, incremental upgrade, legacy heartbeat, malformed control rejection");
