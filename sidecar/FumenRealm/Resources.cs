using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace FumenRealm;

/// lazer's built-in "classic" and "retro" skins aren't in the database: their textures are
/// embedded in osu.Game.Resources.dll (as `osu.Game.Resources.Skins.Legacy.<file>`). This reads
/// them straight out of the PE file's metadata, without loading the assembly, so it works with
/// whatever .NET version the installed lazer targets.
internal static class Resources
{
    private const string Prefix = "osu.Game.Resources.Skins.";

    /// Writes `<outDir>/<skin>/<file>` for every embedded skin resource ("Legacy" → classic,
    /// "Retro" → retro). Returns the number of files written.
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
            var name = md.GetString(res.Name);
            if (!name.StartsWith(Prefix, StringComparison.Ordinal)) continue;

            var rest = name[Prefix.Length..];
            var dot = rest.IndexOf('.');
            if (dot <= 0) continue;
            var skin = rest[..dot] switch
            {
                "Legacy" => "classic",
                "Retro" => "retro",
                _ => null,
            };
            var file = rest[(dot + 1)..];
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
}
