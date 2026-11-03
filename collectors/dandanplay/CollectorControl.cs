using System.Text.Json.Nodes;

internal static class CollectorControl
{
    public record Decision(bool Paused, string Epoch, bool ResetCheckpoint);
    public static Decision Read(JsonNode? control, string? storedEpoch)
    {
        if (control is null) return new(false, "initial", false); // Older cloud version.
        if (control is not JsonObject || control["sync_paused"] is not JsonValue pausedValue || !pausedValue.TryGetValue<bool>(out bool paused) ||
            control["sync_epoch"] is not JsonValue epochValue || !epochValue.TryGetValue<string>(out string? epoch) ||
            (epoch != "initial" && !Guid.TryParseExact(epoch, "D", out _))) throw new InvalidOperationException("INVALID_COLLECTOR_CONTROL");
        bool reset = !paused && epoch != storedEpoch && !(storedEpoch is null && epoch == "initial");
        return new(paused, epoch!, reset);
    }
}
