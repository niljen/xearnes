"""
Xearnes 1B — Données d'entraînement
- Anglais : FLAN (Google, Apache 2.0) — ATTENTION : FLAN ne contient réellement
  que ~2.77M lignes, pas 10M. Le script s'arrête automatiquement quand la
  source est épuisée (pas de crash), mais TARGET_EN=10M ne sera jamais atteint.
- 1M français  : French-Orca-DPO-Mistral (CC-BY-4.0, généré par Mistral) + SmolTalk
- 1M suédois   : Xearnes pairs + OPUS-100 SV
Total réaliste : ~5-7M paires (pas 12M) — voir mémoire du projet pour le détail
"""

from datasets import load_dataset
import json, re, os

OUTPUT_FILE = "xearnes_train.jsonl"
TARGET_EN   = 10_000_000
TARGET_FR   =  1_000_000
TARGET_SV   =  1_000_000

XEARNES_SYSTEM = """Du är Xearnes Orion, en AI-assistent skapad av Youssef från Malmö, Sverige.
Du är entusiastisk, vänlig och intelligent. Du använder 1-2 emojis per svar.
Dina svar är detaljerade och hjälpsamma."""

total        = 0
source_counts = {}

def write_pair(f, user_msg, assistant_msg, source):
    global total
    user_msg      = str(user_msg).strip()
    assistant_msg = str(assistant_msg).strip()
    if not user_msg or not assistant_msg:
        return
    if len(user_msg) < 5 or len(assistant_msg) < 10:
        return
    entry = {
        "messages": [
            {"role": "system",    "content": XEARNES_SYSTEM},
            {"role": "user",      "content": user_msg},
            {"role": "assistant", "content": assistant_msg},
        ],
        "source": source
    }
    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    total += 1
    source_counts[source] = source_counts.get(source, 0) + 1
    if total % 500_000 == 0:
        size_gb = os.path.getsize(OUTPUT_FILE) / 1e9
        print(f"   📊 {total:,} paires — {size_gb:.1f} GB")

print("🚀 Xearnes — Téléchargement des données (12M paires)")
print("   🇬🇧 10M FLAN  | 🇫🇷 1M français | 🇸🇪 1M suédois\n")

with open(OUTPUT_FILE, "w", encoding="utf-8") as f:

    # ══════════════════════════════════════════════
    # 🇬🇧 ANGLAIS — 10M (FLAN, Apache 2.0)
    # ══════════════════════════════════════════════
    print("⬇️  [1/4] FLAN — 10M paires anglais (Apache 2.0)...")
    try:
        count = 0
        ds = load_dataset("Muennighoff/flan", split="train", streaming=True)
        for row in ds:
            if count >= TARGET_EN: break
            write_pair(f, row.get("inputs", ""), row.get("targets", ""), "flan_en")
            count += 1
        print(f"   ✅ {source_counts.get('flan_en', 0):,} paires FLAN")
    except Exception as e:
        print(f"   ⚠️  FLAN: {e}")

    # ══════════════════════════════════════════════
    # 🇫🇷 FRANÇAIS — 1M
    # ══════════════════════════════════════════════
    print("\n⬇️  [2/4] French-Orca-DPO-Mistral — instructions françaises (CC-BY-4.0)...")
    try:
        ds = load_dataset("jpacifico/French-Orca-DPO-Mistral-12k", split="train")
        count = 0
        for row in ds:
            if count >= 60_000: break
            q = row.get("question", "")
            a = row.get("chosen", "")
            if q and a:
                write_pair(f, q, a, "orca_mistral_fr")
                count += 1
        print(f"   ✅ {source_counts.get('orca_mistral_fr', 0):,} paires French-Orca-Mistral")
    except Exception as e:
        print(f"   ⚠️  French-Orca-Mistral: {e}")

    print("\n⬇️  [3/4] Smol-Smoltalk français uniquement (Apache 2.0)...")
    try:
        remaining_fr = TARGET_FR - source_counts.get("orca_mistral_fr", 0)
        ds = load_dataset("HuggingFaceTB/smol-smoltalk", split="train", streaming=True)
        count = 0
        for row in ds:
            if count >= remaining_fr: break
            msgs = row.get("messages", [])
            # Filtre : garde uniquement les conversations en français
            text_sample = " ".join(m.get("content","") for m in msgs[:2])
            fr_chars = sum(1 for c in text_sample if c in "àâäéèêëîïôùûüçœæÀÂÄÉÈÊËÎÏÔÙÛÜÇŒÆ")
            if fr_chars < 2:  # pas assez de caractères français → ignore
                continue
            for j in range(len(msgs) - 1):
                if msgs[j]["role"] == "user" and msgs[j+1]["role"] == "assistant":
                    write_pair(f, msgs[j]["content"], msgs[j+1]["content"], "smoltalk_fr")
                    count += 1
        print(f"   ✅ {source_counts.get('smoltalk_fr', 0):,} paires SmolTalk français")
    except Exception as e:
        print(f"   ⚠️  SmolTalk: {e}")

    # ══════════════════════════════════════════════
    # 🇸🇪 SUÉDOIS — 1M
    # ══════════════════════════════════════════════
    print("\n⬇️  [4/4] Suédois — Xearnes pairs + OPUS-100 SV...")

    # Nos propres paires Xearnes (suédois)
    try:
        ds = load_dataset("niljen/xearnes-training-data", split="train")
        count = 0
        for row in ds:
            msgs = row.get("messages", [])
            if len(msgs) >= 2:
                u = next((m["content"] for m in msgs if m["role"] == "user"), "")
                a = next((m["content"] for m in msgs if m["role"] == "assistant"), "")
                write_pair(f, u, a, "xearnes_sv")
                count += 1
        print(f"   ✅ {count:,} paires Xearnes suédois")
    except Exception as e:
        print(f"   ⚠️  Xearnes pairs: {e}")

    # OPUS-100 suédois (traductions EN→SV de haute qualité)
    try:
        remaining_sv = TARGET_SV - source_counts.get("xearnes_sv", 0)
        ds = load_dataset("Helsinki-NLP/opus-100", "en-sv", split="train", streaming=True)
        count = 0
        for row in ds:
            if count >= remaining_sv: break
            pair = row.get("translation", {})
            en = pair.get("en", "")
            sv = pair.get("sv", "")
            if en and sv:
                # Format : "Traduis en suédois : [EN]" → [SV]
                write_pair(f, f"Hur säger man på svenska: {en}", sv, "opus_sv")
                count += 1
        print(f"   ✅ {source_counts.get('opus_sv', 0):,} paires OPUS suédois")
    except Exception as e:
        print(f"   ⚠️  OPUS-100 SV: {e}")

# ── RÉSUMÉ ────────────────────────────────────────────────────────────────
size_gb = os.path.getsize(OUTPUT_FILE) / 1e9
print(f"\n{'='*55}")
print(f"🎉 TOTAL : {total:,} paires")
print(f"\n📊 Par source :")
for src, n in sorted(source_counts.items(), key=lambda x: -x[1]):
    print(f"   {src:20} : {n:>8,}")
print(f"\n💾 Taille  : {size_gb:.1f} GB")
print(f"📁 Fichier : {OUTPUT_FILE}")
print(f"\n🌍 Langues :")
en = source_counts.get("flan_en", 0)
fr = source_counts.get("orca_mistral_fr", 0) + source_counts.get("smoltalk_fr", 0)
sv = source_counts.get("xearnes_sv", 0) + source_counts.get("opus_sv", 0)
print(f"   🇬🇧 Anglais  : {en:>8,}")
print(f"   🇫🇷 Français : {fr:>8,}")
print(f"   🇸🇪 Suédois  : {sv:>8,}")
print(f"\n✅ Prêt pour l'entraînement de Xearnes 1B !")
