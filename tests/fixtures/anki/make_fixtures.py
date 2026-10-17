import os, sys
from anki.collection import Collection, ExportAnkiPackageOptions, DeckIdLimit
out = sys.argv[1]
path = os.path.join(out, "fixture.anki2")
if os.path.exists(path): os.remove(path)
col = Collection(path)
mm = col.models
def deck(name): return col.decks.id(name)
basic = mm.by_name("Basic"); rev = mm.by_name("Basic (and reversed card)"); cloze = mm.by_name("Cloze")
# custom vocab note type
vocab = mm.new("Japanese Vocab")
for f in ["Word", "Reading", "Meaning", "Example", "Notes"]: mm.add_field(vocab, mm.new_field(f))
t = mm.new_template("Recognition"); t["qfmt"] = "{{Word}}"; t["afmt"] = "{{FrontSide}}<hr id=answer>{{Reading}}<br>{{Meaning}}"; mm.add_template(vocab, t)
t2 = mm.new_template("Production"); t2["qfmt"] = "{{Meaning}}"; t2["afmt"] = "{{FrontSide}}<hr id=answer>{{Word}}"; mm.add_template(vocab, t2)
mm.add(vocab)
vocab = mm.by_name("Japanese Vocab")
def add(model, did, fields, tags=()):
    n = col.new_note(model)
    for k, v in fields.items(): n[k] = v
    n.tags = list(tags)
    col.add_note(n, did)
jv = deck("Japanese::Vocab"); n5 = deck("Japanese::Vocab::N5"); kj = deck("Japanese::Kanji"); es = deck("Spanish")
add(vocab, n5, {"Word": "猫", "Reading": "ねこ", "Meaning": "cat", "Example": "猫が<b>好き</b>です。<br>I like cats.", "Notes": ""}, ["jlpt::n5", "animals"])
add(vocab, n5, {"Word": "食べる", "Reading": "たべる", "Meaning": "to eat", "Example": "", "Notes": "Ichidan verb"}, ["jlpt::n5", "verbs"])
add(vocab, jv, {"Word": "勉強", "Reading": "べんきょう", "Meaning": "study", "Example": "日本語を勉強します。", "Notes": ""}, ["jlpt::n5"])
add(basic, kj, {"Front": "<div>水</div>", "Back": "water<br><i>mizu / sui</i>"}, ["kanji"])
add(basic, kj, {"Front": " 火 ", "Back": "fire&nbsp;(hi / ka)"}, ["kanji"])
add(rev, es, {"Front": "el perro", "Back": "the dog"}, ["nouns"])
add(rev, es, {"Front": "<b>hablar</b>", "Back": "to speak<ul><li>hablo</li><li>hablas</li></ul>"}, ["verbs", "ar-verbs"])
add(cloze, es, {"Text": "Yo {{c1::tengo}} un {{c2::gato::animal}}.", "Back Extra": "tener = to have"}, ["grammar"])
col.save() if hasattr(col, "save") else None
for legacy, name in [(False, "modern.apkg"), (True, "legacy.apkg")]:
    opts = ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=False, with_media=True, legacy=legacy)
    col.export_anki_package(out_path=os.path.join(out, name), options=opts, limit=None)
col.export_collection_package(os.path.join(out, "collection.colpkg"), include_media=True, legacy=False)
print("cards", col.card_count(), "notes", col.note_count())
col.close()
