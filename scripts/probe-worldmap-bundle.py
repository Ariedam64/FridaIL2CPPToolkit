"""List Sprite objects — they usually carry the real asset name."""
from pathlib import Path
from collections import Counter
import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

BUNDLE = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Picto\Worldmaps\worldmap_assets_.bundle")
env = UnityPy.load(str(BUNDLE))

types = Counter()
for obj in env.objects:
    types[obj.type.name] += 1
print("object types:")
for t, n in types.most_common():
    print(f"  {t:20s} {n}")

print()
print("=== sprite names (first 20) ===")
sprites = []
for obj in env.objects:
    if obj.type.name == "Sprite":
        try:
            d = obj.read()
            sprites.append((d.m_Name, getattr(d, "m_Rect", None)))
        except Exception:
            pass
for name, rect in sprites[:20]:
    print(f"  {name}  rect={rect}")

print()
print("=== all sprite unique names ===")
print(sorted(set(s[0] for s in sprites))[:30])

print()
# Check any object with "name" containing worldmap info
print("=== asset info scan ===")
tex_names = []
for obj in env.objects:
    if obj.type.name == "Texture2D":
        try:
            d = obj.read()
            tex_names.append(d.m_Name)
        except Exception:
            pass
# Show distribution of texture names
name_counts = Counter(tex_names)
# Print the MOST frequently-repeated names (those shared across worldmaps)
print("name frequency (top 20):")
for n, c in name_counts.most_common(20):
    print(f"  {n:20s} {c}")
