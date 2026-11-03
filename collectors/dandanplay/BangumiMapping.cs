using LiteDB;
using System.Text.Json.Nodes;

internal static class BangumiMapping
{
    public const string Version = "dandanplay-status-ratings-v2";

    public static void Apply(BsonDocument history, BsonDocument work, JsonObject row)
    {
        if (history["IsFavorited"].IsBoolean) row["following"] = history["IsFavorited"].AsBoolean;
        row["completion_state"] = "unknown";
        var status = Integer(history["FavoriteStatus"]);
        if (status.HasValue)
        {
            row["favorite_status"] = status.Value;
            if (status is 0 or 1 or 2)
            {
                row["completion_state"] = status == 1 ? "completed" : status == 2 ? "abandoned" : "not_completed";
                row["completion_basis"] = "explicit_source_status";
                row["all_episodes_completed"] = status == 1;
            }
        }
        int? watched = Integer(history["EpisodeWatched"]);
        if (watched is >= 0) row["episodes_watched"] = watched.Value;

        // Real local joins show history.Rating == work.Rating (community score).
        // Personal ratings are work.UserRating; 0 explicitly means unrated.
        double? rating = Number(work["UserRating"]);
        row["user_rating_state"] = rating is > 0 and <= 10 ? "rated" : rating == 0 ? "unrated" : "unknown";
        if (rating is >= 0 and <= 10) row["user_rating"] = rating == 0 ? null : JsonValue.Create(rating.Value);
        double? community = Number(work["Rating"]);
        if (community is >= 0 and <= 10) row["community_rating"] = community.Value;

        if (history["Comment"].IsString && !string.IsNullOrWhiteSpace(history["Comment"].AsString))
        {
            string comment = history["Comment"].AsString;
            int length = Math.Min(comment.Length, 1000);
            if (length < comment.Length && char.IsHighSurrogate(comment[length - 1])) length--;
            row["user_comment"] = comment[..length];
            if (length < comment.Length) row["user_comment_truncated"] = true;
        }
    }

    private static double? Number(BsonValue value) => value.IsNumber && double.IsFinite(value.AsDouble) ? value.AsDouble : null;
    private static int? Integer(BsonValue value)
    {
        double? number = Number(value);
        return number.HasValue && number >= int.MinValue && number <= int.MaxValue && number == Math.Truncate(number.Value) ? (int)number.Value : null;
    }
}
