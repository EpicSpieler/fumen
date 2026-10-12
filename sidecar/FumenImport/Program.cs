using System.Collections;
using System.Reflection;
using System.Text.Json;

namespace FumenImport;

/// Imports beatmap archives into osu!lazer with lazer's own code. Started from a folder that holds
/// the installed lazer's runtime and assemblies (hard links, see lazer_import.rs), so everything of
/// lazer is in reach by name; it's used through reflection, which keeps this program independent of
/// lazer's version — whether a version works is what `selftest` and Fumen's version list are for.
///
///   fumen-import info                               lazer's version and database schema version
///   fumen-import import <data-dir> <archive>...     into lazer's library (lazer must be closed)
///   fumen-import collections <data-dir> <json>      collections into lazer's (lazer must be closed)
///   fumen-import selftest <empty-dir> <archive>     into a fresh library, twice
///
/// Output for Fumen: lines starting with "@fumen " followed by JSON (anything else is lazer's
/// logging and ignored). Exit codes: 0 done, 1 failed, 2 usage, 3 database schema doesn't match.
internal static class Program
{
    private const string Mark = "@fumen ";

    private static int Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        try
        {
            return args switch
            {
                ["info"] => Info(),
                ["members", var type] => Members(type),
                ["checkschema", var file, var version] => CheckSchema(file, int.Parse(version)),
                ["import", var dir, .. var files] when files.Length > 0 => Import(dir, files),
                ["collections", var dir, var json] => Collections(dir, json),
                ["selftest", var dir, var file] => SelfTest(dir, file),
                _ => Usage(),
            };
        }
        catch (SchemaMismatch e)
        {
            Emit(new { error = "schema", message = e.Message, file = e.File, code = e.Code });
            return 3;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException { InnerException: { } i } ? i : e;
            Emit(new { error = "failed", message = inner.Message, type = inner.GetType().FullName, stack = inner.StackTrace });
            return 1;
        }
    }

    private static int Usage()
    {
        Console.Error.WriteLine("usage: fumen-import info | import <data-dir> <archive>... | collections <data-dir> <json> | selftest <empty-dir> <archive>");
        return 2;
    }

    private static void Emit(object value) => Console.WriteLine(Mark + JsonSerializer.Serialize(value));

    // ── commands ────────────────────────────────────────────────────────

    private static int Info()
    {
        var game = Lazer.Game;
        Emit(new
        {
            osuGame = game.GetName().Version?.ToString(),
            schema = Lazer.CodeSchemaVersion,
            runtime = Environment.Version.ToString(),
        });
        return 0;
    }

    /// Diagnostics after a lazer update: the constructors and methods of one of its types.
    private static int Members(string typeName)
    {
        var type = new[] { Lazer.Game, Assembly.Load("osu.Framework") }.Select(a => a.GetType(typeName)).FirstOrDefault(t => t != null)
                   ?? throw new MissingMemberException($"{typeName} isn't in osu.Game / osu.Framework");
        const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;
        string Sig(MethodBase m) => $"{m.Name}({string.Join(", ", m.GetParameters().Select(p => $"{p.ParameterType} {p.Name}"))})";
        Emit(new
        {
            type = type.FullName,
            baseTypes = Enumerable.Range(0, 8).Aggregate(new List<string>(), (l, _) => { var b = (l.Count == 0 ? type : type.Assembly.GetType(l[^1]) ?? Type.GetType(l[^1]))?.BaseType; if (b != null) l.Add(b.FullName ?? b.Name); return l; }),
            constructors = type.GetConstructors(all).Select(Sig),
            methods = type.GetMethods(all).Where(m => m.DeclaringType != typeof(object)).Select(m => $"{(m.IsPublic ? "public " : "")}{m.ReturnType.Name} {Sig(m)}"),
        });
        return 0;
    }

    /// Diagnostics / the guard's own test: opens a database as if lazer's schema were `version`.
    private static int CheckSchema(string realmFile, int version)
    {
        Lazer.CheckSchema(realmFile, version);
        Emit(new { ok = true, version });
        return 0;
    }

    private static int Import(string dataDir, string[] files)
    {
        var realmFile = Path.Combine(dataDir, Lazer.ClientDatabase);
        if (!File.Exists(realmFile))
            throw new FileNotFoundException($"No lazer database at {realmFile}");
        // lazer's RealmAccess migrates an older database without a backup and replaces a newer
        // one: only ever open one that's exactly at this lazer's schema
        Lazer.CheckSchema(realmFile);

        using var lazer = Lazer.Open(dataDir);
        foreach (var file in files)
        {
            try
            {
                var ids = lazer.ImportBeatmaps(file);
                Emit(new { file, ok = true, sets = ids });
            }
            catch (Exception e)
            {
                var inner = e is TargetInvocationException { InnerException: { } i } ? i : e;
                Emit(new { file, ok = false, message = inner.Message, type = inner.GetType().FullName });
            }
        }
        return 0;
    }

    /// Puts collections into lazer's: `json` is a file with [{ key, lazerId?, name, md5s }]. Each
    /// goes into the lazer collection with that id, else the first one with that name, else a new
    /// one, and then holds exactly these difficulties under this name. lazer's other collections
    /// stay as they are. One line per collection: { key, id, created }.
    private static int Collections(string dataDir, string json)
    {
        var realmFile = Path.Combine(dataDir, Lazer.ClientDatabase);
        if (!File.Exists(realmFile))
            throw new FileNotFoundException($"No lazer database at {realmFile}");
        Lazer.CheckSchema(realmFile);
        var wanted = JsonSerializer.Deserialize<List<CollectionIn>>(File.ReadAllText(json), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                     ?? throw new InvalidDataException("no collections given");

        using var lazer = Lazer.Open(dataDir);
        foreach (var (c, id, created) in lazer.PutCollections(wanted))
            Emit(new { key = c.Key, id, created });
        return 0;
    }

    /// Imports into a fresh lazer library in `dir` (rulesets set up like on lazer's first start),
    /// then again: lazer must keep the one set. What's in the database afterwards is checked by
    /// Fumen with its own reader (the fumen-realm export).
    private static int SelfTest(string dir, string file)
    {
        Directory.CreateDirectory(dir);
        if (Directory.EnumerateFileSystemEntries(dir).Any())
            throw new InvalidOperationException($"{dir} isn't empty");

        Guid[] first, second;
        using (var lazer = Lazer.Open(dir, setUpRulesets: true))
        {
            first = lazer.ImportBeatmaps(file);
            second = lazer.ImportBeatmaps(file);
        }
        var sameSet = first.Length == 1 && second.SequenceEqual(first);
        Emit(new { imported = first, reimported = second, sameSet, schema = Lazer.CodeSchemaVersion });
        return sameSet ? 0 : 1;
    }
}

internal sealed record CollectionIn(string Key, string? LazerId, string Name, List<string> Md5s);

internal sealed class SchemaMismatch(string message, ulong file, int code) : Exception(message)
{
    public ulong File { get; } = file;
    public int Code { get; } = code;
}

/// lazer's classes, by name.
internal sealed class Lazer : IDisposable
{
    public const string ClientDatabase = "client.realm";
    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    public static Assembly Game => Assembly.Load("osu.Game");
    private static Assembly Framework => Assembly.Load("osu.Framework");
    private static Assembly Realms => Assembly.Load("Realm");

    private static Type T(Assembly a, string name) =>
        a.GetType(name, throwOnError: false) ?? throw new MissingMemberException($"{name} isn't in {a.GetName().Name} (lazer changed?)");

    /// RealmAccess.schema_version: the database schema this lazer reads and writes.
    public static int CodeSchemaVersion =>
        (int)(T(Game, "osu.Game.Database.RealmAccess").GetField("schema_version", Any)?.GetRawConstantValue()
              ?? throw new MissingMemberException("RealmAccess.schema_version is gone (lazer changed?)"));

    /// Throws unless the database at `realmFile` is at exactly lazer's schema (`version` stands
    /// in for lazer's in the guard's own test).
    public static void CheckSchema(string realmFile, int? version = null)
    {
        var code = version ?? CodeSchemaVersion;
        var file = FileSchemaVersion(realmFile);
        if (file != (ulong)code)
            throw new SchemaMismatch(
                file < (ulong)code
                    ? $"lazer's database is at schema {file}, this lazer at {code}: start lazer once so it updates its database"
                    : $"lazer's database is at schema {file}, newer than this lazer's {code}",
                file, code);
    }

    /// The schema version stored in a Realm file, read from a copy (opening is read-only and
    /// dynamic, which works at any version; the version itself is only on Realm's internal handle).
    public static ulong FileSchemaVersion(string realmFile)
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"fumen-schema-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmp);
        try
        {
            var copy = Path.Combine(tmp, "check.realm");
            File.Copy(realmFile, copy);
            var cfgType = T(Realms, "Realms.RealmConfiguration");
            var cfg = Activator.CreateInstance(cfgType, copy)!;
            cfgType.GetProperty("IsReadOnly")!.SetValue(cfg, true);
            cfgType.GetProperty("IsDynamic")!.SetValue(cfg, true);
            var realmType = T(Realms, "Realms.Realm");
            var getInstance = realmType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == "GetInstance" && m.GetParameters() is [{ ParameterType.Name: "RealmConfigurationBase" }]);
            using var realm = (IDisposable)getInstance.Invoke(null, [cfg])!;
            var handle = realmType.GetProperties(Any).FirstOrDefault(p => p.PropertyType.Name == "SharedRealmHandle")?.GetValue(realm)
                         ?? realmType.GetFields(Any).FirstOrDefault(f => f.FieldType.Name == "SharedRealmHandle")?.GetValue(realm)
                         ?? throw new MissingMemberException("Realm's SharedRealmHandle is gone (Realm changed?)");
            var get = handle.GetType().GetMethod("GetSchemaVersion", Any, Type.EmptyTypes)
                      ?? throw new MissingMethodException("SharedRealmHandle.GetSchemaVersion is gone (Realm changed?)");
            return Convert.ToUInt64(get.Invoke(handle, null));
        }
        finally
        {
            try { Directory.Delete(tmp, true); } catch { /* temp */ }
        }
    }

    private readonly object _storage;
    private readonly IDisposable _realm;
    private readonly object _importer;

    private Lazer(object storage, IDisposable realm, object importer)
    {
        _storage = storage;
        _realm = realm;
        _importer = importer;
    }

    /// lazer's storage and database at `dataDir`, and its beatmap importer.
    public static Lazer Open(string dataDir, bool setUpRulesets = false)
    {
        var storageType = T(Framework, "osu.Framework.Platform.NativeStorage");
        var storage = Construct(storageType, dataDir);
        var realmType = T(Game, "osu.Game.Database.RealmAccess");
        var realm = (IDisposable)Construct(realmType, storage, ClientDatabase);
        try
        {
            if (setUpRulesets)
            {
                // what lazer does on its first start: rulesets found next to it go into the database
                var rulesets = Construct(T(Game, "osu.Game.Rulesets.RealmRulesetStore"), realm, storage);
                (rulesets as IDisposable)?.Dispose();
            }
            var importer = Construct(T(Game, "osu.Game.Beatmaps.BeatmapImporter"), storage, realm);
            return new Lazer(storage, realm, importer);
        }
        catch
        {
            realm.Dispose();
            throw;
        }
    }

    /// Imports one archive; returns the IDs of the sets lazer has for it afterwards (an archive
    /// lazer already has gives the existing set).
    public Guid[] ImportBeatmaps(string file)
    {
        if (!File.Exists(file)) throw new FileNotFoundException($"No archive at {file}");
        var taskType = T(Game, "osu.Game.Database.ImportTask");
        var paramsType = T(Game, "osu.Game.Database.ImportParameters");
        // Task<Live<BeatmapSetInfo>?> Import(ImportTask task, ImportParameters parameters, CancellationToken token)
        var import = _importer.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m => m.Name == "Import" && m.GetParameters() is [{ } a, { } b, { } c]
                                 && a.ParameterType == taskType && b.ParameterType == paramsType && c.ParameterType == typeof(CancellationToken))
            ?? throw new MissingMethodException("BeatmapImporter.Import(ImportTask, ImportParameters, CancellationToken) is gone (lazer changed?)");
        // lazer deletes .osz archives it imported: hand it a copy, never the caller's file
        var tmp = Path.Combine(Path.GetTempPath(), $"fumen-import-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmp);
        var copy = Path.Combine(tmp, Path.GetFileName(file));
        File.Copy(file, copy);
        Task running;
        try
        {
            running = (Task)import.Invoke(_importer, [Construct(taskType, copy), Activator.CreateInstance(paramsType), CancellationToken.None])!;
            running.GetAwaiter().GetResult();
        }
        finally
        {
            try { Directory.Delete(tmp, true); } catch { /* temp */ }
        }
        // null: lazer found nothing to import in the archive
        var live = running.GetType().GetProperty("Result")!.GetValue(running);
        return live == null ? [] : [(Guid)live.GetType().GetProperty("ID", BindingFlags.Public | BindingFlags.Instance)!.GetValue(live)!];
    }

    /// Writes collections in one of lazer's own write transactions (RealmAccess.Write); returns
    /// lazer's id for each and whether it was made new.
    public List<(CollectionIn, Guid, bool)> PutCollections(IReadOnlyList<CollectionIn> wanted)
    {
        var realmType = T(Realms, "Realms.Realm");
        // void Write(Action<Realm> action)
        var write = _realm.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(m => m.Name == "Write" && m.ReturnType == typeof(void) && m.GetParameters() is [{ ParameterType: var p }]
                                 && p == typeof(Action<>).MakeGenericType(realmType))
            ?? throw new MissingMethodException("RealmAccess.Write(Action<Realm>) is gone (lazer changed?)");
        var writer = new CollectionWriter(T(Game, "osu.Game.Collections.BeatmapCollection"), realmType, wanted);
        var apply = typeof(CollectionWriter).GetMethod(nameof(CollectionWriter.Apply))!.MakeGenericMethod(realmType);
        write.Invoke(_realm, [Delegate.CreateDelegate(typeof(Action<>).MakeGenericType(realmType), writer, apply)]);
        return writer.Done;
    }

    /// The writing itself, on lazer's Realm (its type only known at run time).
    private sealed class CollectionWriter(Type collectionType, Type realmType, IReadOnlyList<CollectionIn> wanted)
    {
        public readonly List<(CollectionIn, Guid, bool)> Done = [];

        public void Apply<TRealm>(TRealm realm)
        {
            Done.Clear();
            var all = realmType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .First(m => m.Name == "All" && m.IsGenericMethodDefinition && m.GetParameters().Length == 0)
                .MakeGenericMethod(collectionType);
            var add = realmType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(m => m.Name == "Add" && m.IsGenericMethodDefinition && m.GetParameters() is [{ ParameterType.IsGenericParameter: true }, { ParameterType: var u }] && u == typeof(bool))
                ?.MakeGenericMethod(collectionType)
                ?? throw new MissingMethodException("Realm.Add<T>(T, bool) is gone (Realm changed?)");
            var id = collectionType.GetProperty("ID")!;
            var name = collectionType.GetProperty("Name")!;
            var hashes = collectionType.GetProperty("BeatmapMD5Hashes")!;
            var modified = collectionType.GetProperty("LastModified")!;
            var existing = ((System.Collections.IEnumerable)all.Invoke(realm, null)!).Cast<object>().ToList();

            foreach (var c in wanted)
            {
                var target = (Guid.TryParse(c.LazerId, out var g) ? existing.FirstOrDefault(e => (Guid)id.GetValue(e)! == g) : null)
                             ?? existing.FirstOrDefault(e => (string?)name.GetValue(e) == c.Name);
                var md5s = c.Md5s.Distinct().ToList();
                if (target == null)
                {
                    target = Construct(collectionType, c.Name, md5s);
                    add.Invoke(realm, [target, false]);
                    existing.Add(target);
                    Done.Add((c, (Guid)id.GetValue(target)!, true));
                    continue;
                }
                // the generic list: Realm's non-generic IList.Add recurses into itself
                var list = (IList<string>)hashes.GetValue(target)!;
                if ((string?)name.GetValue(target) != c.Name) name.SetValue(target, c.Name);
                if (!list.SequenceEqual(md5s))
                {
                    list.Clear();
                    foreach (var h in md5s) list.Add(h);
                }
                modified.SetValue(target, DateTimeOffset.Now);
                Done.Add((c, (Guid)id.GetValue(target)!, false));
            }
        }
    }

    /// The constructor of `type` that takes these arguments (trailing optional ones left out).
    private static object Construct(Type type, params object?[] args)
    {
        foreach (var ctor in type.GetConstructors(BindingFlags.Public | BindingFlags.Instance))
        {
            var ps = ctor.GetParameters();
            if (ps.Length < args.Length || ps.Skip(args.Length).Any(p => !p.HasDefaultValue)) continue;
            var ok = true;
            for (var i = 0; i < args.Length && ok; i++)
                ok = args[i] == null ? !ps[i].ParameterType.IsValueType : ps[i].ParameterType.IsInstanceOfType(args[i]);
            if (!ok) continue;
            var full = args.Concat(ps.Skip(args.Length).Select(p => p.DefaultValue)).ToArray();
            return ctor.Invoke(full);
        }
        throw new MissingMethodException($"No constructor of {type.FullName} for ({string.Join(", ", args.Select(a => a?.GetType().Name ?? "null"))}) (lazer changed?)");
    }

    public void Dispose() => _realm.Dispose();
}
