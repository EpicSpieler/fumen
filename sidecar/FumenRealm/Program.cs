// fumen-realm — exports osu!lazer's library (client.realm) to JSON for Fumen.
//
//   fumen-realm export <client.realm> <out.json>   full export, progress lines on stdout
//   fumen-realm probe  <client.realm>              counts only (diagnostics)
//   fumen-realm skin-resources <osu.Game.Resources.dll> <out-dir>
//                                                  lazer's built-in classic/retro skin textures
//
// Safety: the live database is never opened. It is copied (sharing read/write with a running
// lazer) into a temp folder and the copy is opened read-only in dynamic mode, so lazer schema
// additions don't break us and we can never upgrade or lock lazer's file.
//
// stdout protocol (one line each, flushed):
//   progress <stage> <done> <total>
//   done <sets> <maps> <scores> <collections> <skins>   (export)
//   done <files>                                     (skin-resources)
// Errors go to stderr as "error <code> <message>" with a non-zero exit code.

using System.Text.Encodings.Web;
using System.Text.Json;
using Realms;

namespace FumenRealm;

internal static class Program
{
    /// Bump when the JSON shape changes; Fumen refuses documents it doesn't understand.
    private const int FormatVersion = 1;

    private static int Main(string[] args)
    {
        try
        {
            return args switch
            {
                ["export", var realm, var outPath] => Export(realm, outPath),
                ["probe", var realm] => Probe(realm),
                ["skin-resources", var dll, var outDir] => SkinResources(dll, outDir),
                _ => Usage(),
            };
        }
        catch (FumenException e)
        {
            Console.Error.WriteLine($"error {e.Code} {e.Message}");
            return e.Code == "unsupported-format" ? 3 : 1;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"error internal {e.GetType().Name}: {e.Message}");
            return 1;
        }
    }

    private static int Usage()
    {
        Console.Error.WriteLine("usage: fumen-realm export <client.realm> <out.json> | probe <client.realm> | skin-resources <dll> <out-dir>");
        return 2;
    }

    // ── Commands ────────────────────────────────────────────────────────────

    private static int Probe(string realmPath)
    {
        using var session = RealmSession.Open(realmPath);
        var api = session.Realm.DynamicApi;
        using var stdout = Console.OpenStandardOutput();
        using (var w = new Utf8JsonWriter(stdout))
        {
            w.WriteStartObject();
            w.WriteNumber("format", FormatVersion);
            w.WriteNumber("sets", api.All("BeatmapSet").Count());
            w.WriteNumber("maps", api.All("Beatmap").Count());
            w.WriteNumber("scores", api.All("Score").Count());
            w.WriteNumber("collections", api.All("BeatmapCollection").Count());
            w.WriteEndObject();
        }
        stdout.WriteByte((byte)'\n');
        return 0;
    }

    private static int Export(string realmPath, string outPath)
    {
        Progress("copy", 0, 1);
        using var session = RealmSession.Open(realmPath);
        Progress("copy", 1, 1);

        var tmpOut = outPath + ".part";
        int sets, maps, scores, collections, skins;
        using (var stream = new FileStream(tmpOut, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
        using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            w.WriteStartObject();
            w.WriteNumber("format", FormatVersion);
            w.WriteString("source", "lazer");
            w.WriteNumber("exportedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            (sets, maps) = Exporter.WriteSets(session.Realm, w);
            scores = Exporter.WriteScores(session.Realm, w);
            collections = Exporter.WriteCollections(session.Realm, w);
            Exporter.WriteRulesetSettings(session.Realm, w);
            skins = Exporter.WriteSkins(session.Realm, w);

            w.WriteEndObject();
        }

        File.Move(tmpOut, outPath, overwrite: true);
        Console.WriteLine($"done {sets} {maps} {scores} {collections} {skins}");
        return 0;
    }

    private static int SkinResources(string dll, string outDir)
    {
        Console.WriteLine($"done {Resources.ExtractSkins(dll, outDir)}");
        return 0;
    }

    internal static void Progress(string stage, int done, int total)
    {
        Console.WriteLine($"progress {stage} {done} {total}");
        Console.Out.Flush();
    }
}

internal sealed class FumenException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// A read-only dynamic Realm opened on a private temp copy; disposing deletes the copy.
internal sealed class RealmSession : IDisposable
{
    public Realm Realm { get; }
    private readonly string _dir;

    private RealmSession(Realm realm, string dir)
    {
        Realm = realm;
        _dir = dir;
    }

    public static RealmSession Open(string realmPath)
    {
        if (!File.Exists(realmPath))
            throw new FumenException("not-found", $"No database at {realmPath}");

        // lazer may commit while we copy; a torn copy fails to open → copy once more.
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var dir = Path.Combine(Path.GetTempPath(), "fumen-realm", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var copy = Path.Combine(dir, "client.realm");
            try
            {
                using (var src = new FileStream(realmPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var dst = new FileStream(copy, FileMode.CreateNew, FileAccess.Write))
                    src.CopyTo(dst);

                var realm = Realm.GetInstance(new RealmConfiguration(copy) { IsDynamic = true, IsReadOnly = true });
                return new RealmSession(realm, dir);
            }
            catch (Exception e)
            {
                last = e;
                TryDelete(dir);
                if (IsFormatError(e))
                    throw new FumenException("unsupported-format",
                        "This osu!lazer version uses a newer database format than Fumen understands. Update Fumen.");
                Thread.Sleep(400);
            }
        }
        throw new FumenException("open-failed", last?.Message ?? "Could not open the database");
    }

    private static bool IsFormatError(Exception e)
    {
        var m = e.Message.ToLowerInvariant();
        return m.Contains("file format") || m.Contains("upgrade") || m.Contains("history type");
    }

    public void Dispose()
    {
        Realm.Dispose();
        TryDelete(_dir);
    }

    private static void TryDelete(string dir)
    {
        try { Directory.Delete(dir, recursive: true); } catch { /* temp; Windows may still hold the lock file */ }
    }
}
