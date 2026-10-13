using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace FumenRealm;

/// lazer's built-in "classic" and "retro" skins aren't in the database: their textures are
/// embedded in osu.Game.Resources.dll (as `osu.Game.Resources.Skins.Legacy.<file>`), and so are
/// the hit sounds of the argon / triangles skins (`osu.Game.Resources.Samples.Gameplay[.Argon|
/// .ArgonPro].<file>`, argon's own osu!taiko drums included) and the drum textures of lazer's
/// default osu!taiko playfield (`osu.Game.Resources.Textures.Gameplay.taiko.<file>`). This reads
/// them straight out of the PE file's metadata, without loading the assembly, so it works with
/// whatever .NET version the installed lazer targets.
internal static class Resources
{
    private const string SkinPrefix = "osu.Game.Resources.Skins.";
    private const string SamplePrefix = "osu.Game.Resources.Samples.Gameplay.";
    private const string TaikoTexturePrefix = "osu.Game.Resources.Textures.Gameplay.taiko.";

    /// Writes `<outDir>/<skin>/<file>` for every embedded skin resource ("Legacy" → classic,
    /// "Retro" → retro), every gameplay hit sound (→ triangles, argon, argon-pro) and the default
    /// osu!taiko drum (→ triangles). Returns the number of files written.
    public static int ExtractSkins(string dllPath, string outDir)
    {
        if (!File.Exists(dllPath))
            throw new FumenException("not-found", $"No file at {dllPath}");

        using var stream = File.OpenRead(dllPath);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        var dir = pe.PEHeaders.CorHeader?.ResourcesDirectory
                  ?? throw new FumenException("bad-dll", "Not a .NET assembly");
        var block = pe.GetSectionData(dir.RelativeVirtualAddress);

        var count = 0;
        foreach (var handle in md.ManifestResources)
        {
            var res = md.GetManifestResource(handle);
            if (!res.Implementation.IsNil) continue; // lives in another file
            var (skin, file) = Target(md.GetString(res.Name));
            if (skin == null || file.Length == 0 || file.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) continue;

            // embedded resources: a 4-byte length, then the bytes
            var reader = block.GetReader((int)res.Offset, block.Length - (int)res.Offset);
            var length = reader.ReadInt32();
            var bytes = reader.ReadBytes(length);

            var target = Path.Combine(outDir, skin);
            Directory.CreateDirectory(target);
            File.WriteAllBytes(Path.Combine(target, file), bytes);
            count++;
        }
        return count;
    }

    /// Where an embedded resource goes: (skin folder, file name), or (null, "") to skip it.
    private static (string? skin, string file) Target(string name)
    {
        if (name.StartsWith(SkinPrefix, StringComparison.Ordinal))
        {
            var rest = name[SkinPrefix.Length..];
            var dot = rest.IndexOf('.');
            if (dot <= 0) return (null, "");
            var skin = rest[..dot] switch
            {
                "Legacy" => "classic",
                "Retro" => "retro",
                _ => null,
            };
            return (skin, rest[(dot + 1)..]);
        }
        if (name.StartsWith(SamplePrefix, StringComparison.Ordinal))
        {
            var rest = name[SamplePrefix.Length..];
            var skin = "triangles";
            foreach (var (folder, id) in new[] { ("ArgonPro.", "argon-pro"), ("Argon.", "argon") })
            {
                if (!rest.StartsWith(folder, StringComparison.Ordinal)) continue;
                skin = id;
                rest = rest[folder.Length..];
                break;
            }
            // hit sounds only (normal-hitnormal.wav …), not the game's other effects; argon has
            // its own osu!taiko drums (taiko-drum-hitnormal.wav, taiko-strong-hitflourish.wav …)
            var bank = rest.Split('-')[0];
            var hit = bank is "normal" or "soft" or "drum" || (bank == "taiko" && skin == "argon");
            return hit ? (skin, rest) : (null, "");
        }
        if (name.StartsWith(TaikoTexturePrefix, StringComparison.Ordinal))
            return ("triangles", name[TaikoTexturePrefix.Length..]);
        return (null, "");
    }
}
