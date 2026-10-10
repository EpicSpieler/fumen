using System.Text.Json;
using Realms;

namespace FumenRealm;

/// Writes the lazer library as JSON. Every field read goes through <see cref="F"/>, which
/// tolerates missing properties and unexpected types, so a lazer schema change degrades a field
/// to null instead of failing the whole export.
internal static class Exporter
{
    // ── Beatmap sets + difficulties ─────────────────────────────────────────

    public static (int sets, int maps) WriteSets(Realm realm, Utf8JsonWriter w)
    {
        var all = realm.DynamicApi.All("BeatmapSet").ToList();
        int total = all.Count, done = 0, setCount = 0, mapCount = 0;

        w.WriteStartArray("sets");
        foreach (var set in all)
        {
            if (++done % 200 == 0) Program.Progress("sets", done, total);
            if (F.Bool(set, "DeletePending")) continue;

            var files = FileIndex(set);

            w.WriteStartObject();
            w.WriteString("id", F.Guid(set, "ID"));
            F.WriteInt(w, "onlineId", F.Int(set, "OnlineID"));
            F.WriteInt(w, "status", F.Int(set, "Status"));
            F.WriteDate(w, "dateAdded", F.Date(set, "DateAdded"));
            F.WriteDate(w, "dateSubmitted", F.Date(set, "DateSubmitted"));
            F.WriteDate(w, "dateRanked", F.Date(set, "DateRanked"));
            w.WriteBoolean("protected", F.Bool(set, "Protected"));
            F.WriteStr(w, "hash", F.Str(set, "Hash"));

            w.WriteStartArray("maps");
            foreach (var map in F.List(set, "Beatmaps"))
            {
                WriteMap(w, map, files);
                mapCount++;
            }
            w.WriteEndArray();

            w.WriteEndObject();
            setCount++;
        }
        w.WriteEndArray();
        Program.Progress("sets", total, total);
        return (setCount, mapCount);
    }

    /// Filename → content hash for one set (lazer stores files by SHA-256 under files/).
    private static Dictionary<string, string> FileIndex(IRealmObjectBase set)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var usage in F.List(set, "Files"))
        {
            var name = F.Str(usage, "Filename");
            var hash = F.Str(F.Link(usage, "File"), "Hash");
            if (name != null && hash != null) map[NormalisePath(name)] = hash;
        }
        return map;
    }

    private static string NormalisePath(string p) => p.Replace('\\', '/').Trim();

    private static void WriteMap(Utf8JsonWriter w, IRealmObjectBase map, Dictionary<string, string> files)
    {
        var ruleset = F.Link(map, "Ruleset");
        var diff = F.Link(map, "Difficulty");
        var meta = F.Link(map, "Metadata");
        var author = F.Link(meta, "Author");

        w.WriteStartObject();
        w.WriteString("id", F.Guid(map, "ID"));
        F.WriteInt(w, "onlineId", F.Int(map, "OnlineID"));
        F.WriteStr(w, "version", F.Str(map, "DifficultyName"));
        F.WriteStr(w, "ruleset", F.Str(ruleset, "ShortName"));
        F.WriteInt(w, "rulesetId", F.Int(ruleset, "OnlineID"));
        F.WriteInt(w, "status", F.Int(map, "Status"));
        F.WriteStr(w, "hash", F.Str(map, "Hash"));
        F.WriteStr(w, "md5", F.Str(map, "MD5Hash"));
        F.WriteNum(w, "sr", F.Num(map, "StarRating"));
        F.WriteNum(w, "bpm", F.Num(map, "BPM"));
        F.WriteNum(w, "length", F.Num(map, "Length"));
        F.WriteInt(w, "objects", F.Int(map, "TotalObjectCount"));
        F.WriteInt(w, "endObjects", F.Int(map, "EndTimeObjectCount"));
        F.WriteDate(w, "lastPlayed", F.Date(map, "LastPlayed"));
        F.WriteDate(w, "lastUpdate", F.Date(map, "LastLocalUpdate"));
        w.WriteBoolean("hidden", F.Bool(map, "Hidden"));

        F.WriteNum(w, "hp", F.Num(diff, "DrainRate"));
        F.WriteNum(w, "cs", F.Num(diff, "CircleSize"));
        F.WriteNum(w, "od", F.Num(diff, "OverallDifficulty"));
        F.WriteNum(w, "ar", F.Num(diff, "ApproachRate"));

        F.WriteStr(w, "title", F.Str(meta, "Title"));
        F.WriteStr(w, "titleUnicode", F.Str(meta, "TitleUnicode"));
        F.WriteStr(w, "artist", F.Str(meta, "Artist"));
        F.WriteStr(w, "artistUnicode", F.Str(meta, "ArtistUnicode"));
        F.WriteStr(w, "creator", F.Str(author, "Username"));
        F.WriteInt(w, "creatorId", F.Int(author, "OnlineID"));
        F.WriteStr(w, "source", F.Str(meta, "Source"));
        F.WriteStr(w, "tags", F.Str(meta, "Tags"));
        F.WriteInt(w, "previewTime", F.Int(meta, "PreviewTime"));

        var audioFile = F.Str(meta, "AudioFile");
        var bgFile = F.Str(meta, "BackgroundFile");
        F.WriteStr(w, "audioFile", audioFile);
        F.WriteStr(w, "bgFile", bgFile);
        F.WriteStr(w, "audio", Resolve(files, audioFile));
        F.WriteStr(w, "bg", Resolve(files, bgFile));

        w.WriteEndObject();
    }

    private static string? Resolve(Dictionary<string, string> files, string? name) =>
        string.IsNullOrWhiteSpace(name) ? null : files.GetValueOrDefault(NormalisePath(name));

    // ── Scores ──────────────────────────────────────────────────────────────

    public static int WriteScores(Realm realm, Utf8JsonWriter w)
    {
        var all = realm.DynamicApi.All("Score").ToList();
        int total = all.Count, done = 0, count = 0;

        w.WriteStartArray("scores");
        foreach (var s in all)
        {
            if (++done % 500 == 0) Program.Progress("scores", done, total);
            if (F.Bool(s, "DeletePending")) continue;

            var beatmap = F.Link(s, "BeatmapInfo");
            var user = F.Link(s, "User");

            w.WriteStartObject();
            w.WriteString("id", F.Guid(s, "ID"));
            F.WriteStr(w, "mapId", beatmap == null ? null : F.Guid(beatmap, "ID"));
            F.WriteStr(w, "mapMd5", F.Str(beatmap, "MD5Hash"));
            F.WriteStr(w, "mapHash", F.Str(s, "BeatmapHash"));
            F.WriteStr(w, "ruleset", F.Str(F.Link(s, "Ruleset"), "ShortName"));
            F.WriteInt(w, "totalScore", F.Int(s, "TotalScore"));
            F.WriteInt(w, "legacyTotalScore", F.Int(s, "LegacyTotalScore"));
            F.WriteNum(w, "accuracy", F.Num(s, "Accuracy"));
            F.WriteInt(w, "maxCombo", F.Int(s, "MaxCombo"));
            F.WriteInt(w, "rank", F.Int(s, "Rank"));
            F.WriteNum(w, "pp", F.Num(s, "PP"));
            F.WriteDate(w, "date", F.Date(s, "Date"));
            F.WriteStr(w, "mods", F.Str(s, "Mods"));
            F.WriteStr(w, "statistics", F.Str(s, "Statistics"));
            F.WriteStr(w, "maximumStatistics", F.Str(s, "MaximumStatistics"));
            F.WriteInt(w, "onlineId", F.Int(s, "OnlineID"));
            F.WriteInt(w, "legacyOnlineId", F.Int(s, "LegacyOnlineID"));
            w.WriteBoolean("legacy", F.Bool(s, "IsLegacyScore"));
            F.WriteStr(w, "user", F.Str(user, "Username"));
            F.WriteInt(w, "userId", F.Int(user, "OnlineID"));
            F.WriteStr(w, "clientVersion", F.Str(s, "ClientVersion"));
            w.WriteEndObject();
            count++;
        }
        w.WriteEndArray();
        Program.Progress("scores", total, total);
        return count;
    }

    // ── Collections ─────────────────────────────────────────────────────────

    public static int WriteCollections(Realm realm, Utf8JsonWriter w)
    {
        var count = 0;
        w.WriteStartArray("collections");
        foreach (var c in realm.DynamicApi.All("BeatmapCollection"))
        {
            w.WriteStartObject();
            w.WriteString("id", F.Guid(c, "ID"));
            F.WriteStr(w, "name", F.Str(c, "Name"));
            F.WriteDate(w, "modified", F.Date(c, "LastModified"));
            w.WriteStartArray("md5s");
            foreach (var md5 in F.StrList(c, "BeatmapMD5Hashes")) w.WriteStringValue(md5);
            w.WriteEndArray();
            w.WriteEndObject();
            count++;
        }
        w.WriteEndArray();
        Program.Progress("collections", count, count);
        return count;
    }

    // ── Ruleset settings (scroll speed and direction for the mania preview) ──

    public static void WriteRulesetSettings(Realm realm, Utf8JsonWriter w)
    {
        w.WriteStartArray("rulesetSettings");
        // lazer maps RealmRulesetSetting to "RulesetSetting"; older schemas used the class name
        var name = new[] { "RulesetSetting", "RealmRulesetSetting" }.FirstOrDefault(n => realm.Schema.TryFindObjectSchema(n, out _));
        if (name != null)
        {
            foreach (var s in realm.DynamicApi.All(name))
            {
                w.WriteStartObject();
                F.WriteStr(w, "ruleset", F.Str(s, "RulesetName"));
                F.WriteInt(w, "variant", F.Int(s, "Variant"));
                F.WriteStr(w, "key", F.Str(s, "Key"));
                F.WriteStr(w, "value", F.Str(s, "Value"));
                w.WriteEndObject();
            }
        }
        w.WriteEndArray();
    }

    // ── Skins (for the playfield preview) ───────────────────────────────────

    /// Every skin lazer knows, built-in ones included (those have no files; their type is in
    /// `instantiationInfo`). Files are written as [filename, hash] pairs.
    public static int WriteSkins(Realm realm, Utf8JsonWriter w)
    {
        var count = 0;
        w.WriteStartArray("skins");
        if (realm.Schema.TryFindObjectSchema("Skin", out _))
        {
            foreach (var s in realm.DynamicApi.All("Skin"))
            {
                if (F.Bool(s, "DeletePending")) continue;
                w.WriteStartObject();
                w.WriteString("id", F.Guid(s, "ID"));
                F.WriteStr(w, "name", F.Str(s, "Name"));
                F.WriteStr(w, "creator", F.Str(s, "Creator"));
                F.WriteStr(w, "instantiationInfo", F.Str(s, "InstantiationInfo"));
                w.WriteBoolean("protected", F.Bool(s, "Protected"));
                w.WriteStartArray("files");
                foreach (var usage in F.List(s, "Files"))
                {
                    var name = F.Str(usage, "Filename");
                    var hash = F.Str(F.Link(usage, "File"), "Hash");
                    if (name == null || hash == null) continue;
                    w.WriteStartArray();
                    w.WriteStringValue(NormalisePath(name));
                    w.WriteStringValue(hash);
                    w.WriteEndArray();
                }
                w.WriteEndArray();
                w.WriteEndObject();
                count++;
            }
        }
        w.WriteEndArray();
        Program.Progress("skins", count, count);
        return count;
    }
}

/// Tolerant field access over dynamic Realm objects.
internal static class F
{
    private static bool Has(IRealmObjectBase? o, string name) =>
        o?.ObjectSchema != null && o.ObjectSchema.TryFindProperty(name, out _);

    private static RealmValue Get(IRealmObjectBase? o, string name)
    {
        if (!Has(o, name)) return RealmValue.Null;
        try { return o!.DynamicApi.Get<RealmValue>(name); }
        catch { return RealmValue.Null; }
    }

    public static IRealmObjectBase? Link(IRealmObjectBase? o, string name)
    {
        if (!Has(o, name)) return null;
        try { return o!.DynamicApi.Get<IRealmObjectBase?>(name); }
        catch { return null; }
    }

    public static IEnumerable<IRealmObjectBase> List(IRealmObjectBase? o, string name)
    {
        if (!Has(o, name)) return [];
        try { return o!.DynamicApi.GetList<IRealmObjectBase>(name); }
        catch
        {
            // embedded-object lists are typed differently in some SDK versions
            try { return o!.DynamicApi.GetList<IEmbeddedObject>(name); }
            catch { return []; }
        }
    }

    public static IEnumerable<string> StrList(IRealmObjectBase? o, string name)
    {
        if (!Has(o, name)) return [];
        try { return o!.DynamicApi.GetList<string?>(name).Where(s => s != null).Select(s => s!); }
        catch { return []; }
    }

    public static string? Str(IRealmObjectBase? o, string name)
    {
        var v = Get(o, name);
        return v.Type == RealmValueType.String ? v.AsString() : null;
    }

    public static string Guid(IRealmObjectBase? o, string name)
    {
        var v = Get(o, name);
        return v.Type switch
        {
            RealmValueType.Guid => v.AsGuid().ToString(),
            RealmValueType.ObjectId => v.AsObjectId().ToString(),
            RealmValueType.String => v.AsString(),
            _ => "",
        };
    }

    public static long? Int(IRealmObjectBase? o, string name)
    {
        var v = Get(o, name);
        return v.Type switch
        {
            RealmValueType.Int => v.AsInt64(),
            RealmValueType.Bool => v.AsBool() ? 1 : 0,
            _ => null,
        };
    }

    public static double? Num(IRealmObjectBase? o, string name)
    {
        var v = Get(o, name);
        return v.Type switch
        {
            RealmValueType.Double => v.AsDouble(),
            RealmValueType.Float => v.AsFloat(),
            RealmValueType.Int => v.AsInt64(),
            RealmValueType.Decimal128 => (double)v.AsDecimal(),
            _ => null,
        };
    }

    public static bool Bool(IRealmObjectBase? o, string name)
    {
        var v = Get(o, name);
        return v.Type == RealmValueType.Bool && v.AsBool();
    }

    public static DateTimeOffset? Date(IRealmObjectBase? o, string name)
    {
        var v = Get(o, name);
        return v.Type == RealmValueType.Date ? v.AsDate() : null;
    }

    // ── writers that skip nulls (keeps the document small) ──

    public static void WriteStr(Utf8JsonWriter w, string key, string? v)
    {
        if (v != null) w.WriteString(key, v);
    }

    public static void WriteInt(Utf8JsonWriter w, string key, long? v)
    {
        if (v.HasValue) w.WriteNumber(key, v.Value);
    }

    public static void WriteNum(Utf8JsonWriter w, string key, double? v)
    {
        if (v.HasValue && double.IsFinite(v.Value)) w.WriteNumber(key, Math.Round(v.Value, 4));
    }

    public static void WriteDate(Utf8JsonWriter w, string key, DateTimeOffset? v)
    {
        if (v.HasValue) w.WriteNumber(key, v.Value.ToUnixTimeMilliseconds());
    }
}
