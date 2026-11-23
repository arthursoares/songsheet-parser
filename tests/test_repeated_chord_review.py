from pathlib import Path

from repeated_chord_review import collect_groups, render_report, representative_crops
from songsheet_io import save_document

FROM = "0,2,0,0,3,2"
TO = "0,2,x,0,3,2"


def _song(root, file, *entries):
    path = root / file
    path.parent.mkdir(parents=True, exist_ok=True)
    save_document(
        path,
        {
            "document": {"title": "Album"},
            "songs": [
                {
                    "title": "Song <A>",
                    "sections": [
                        {
                            "bars": [
                                [
                                    {
                                        "chord": label,
                                        "voicing": current,
                                        **({"voicing_printed": printed} if printed else {}),
                                    }
                                ]
                                for label, current, printed in entries
                            ]
                        }
                    ],
                }
            ],
        },
    )


def test_repeated_disagreements_rank_by_distinct_songs_and_keep_fingering_variants(tmp_path):
    alternate = "0,x,4,0,3,2"
    for index, label in enumerate(("Em9", "Em79", "Em7/9")):
        _song(tmp_path, f"a/{index}.json", (label, FROM, TO), ("Em9/G", FROM, TO))
    for index in range(2):
        _song(tmp_path, f"b/{index}.json", *[("Em7(9)", alternate, TO)] * 8)
    _song(tmp_path, "a/03-qa-song.json", ("Em9", FROM, TO))
    _song(tmp_path, "a/04.json", ("Em9", TO, TO), ("Em9", FROM, None), ("Am", FROM, TO))
    (tmp_path / "a" / "invalid.json").write_text("{", encoding="utf-8")

    groups, counts = collect_groups(tmp_path)

    assert len(groups) == 3
    assert groups[0].name == "Em9 family"
    assert len(groups[0].songs) == len(groups[0].matches) == 3
    assert groups[0].labels == {"Em9": 1, "Em79": 1, "Em7/9": 1}
    assert groups[1].name == "Em9/G"
    assert len(groups[2].songs) == 2
    assert len(groups[2].matches) == 16
    assert counts == {"songs": 6, "compared": 24, "differ": 23, "qa_copies": 1, "invalid_files": 1}

    rendered = render_report(groups, counts, {}, {1})
    assert "Em9 pilot" in rendered
    assert 'href="#group-1"' in rendered
    assert 'scope="col" class="changed">D<' in rendered
    assert "Song &lt;A&gt;" in rendered and "Song <A>" not in rendered
    assert "No reliable crop matched in the sample." in rendered
    assert "1 invalid song files skipped" in rendered


def test_crop_sampling_tries_distinct_albums_before_retrying_an_album(tmp_path):
    _song(tmp_path, "a/01.json", ("Em9", FROM, TO))
    _song(tmp_path, "a/02.json", ("Em9", FROM, TO))
    _song(tmp_path, "b/01.json", ("Em7/9", FROM, TO))
    _song(tmp_path, "c/01.json", ("Em79", FROM, TO))
    groups, _ = collect_groups(tmp_path)
    attempts = []

    class Reader:
        def crop_for(self, path, *_coords, expected):
            assert expected[1:] == (FROM, TO)
            relative = path.relative_to(tmp_path)
            attempts.append(relative)
            if relative == Path("a/01.json"):
                return None
            return {"image": "data:image/png;base64,AA==", "page": 1, "basis": "Source"}

    examples = representative_crops(groups[0], tmp_path, Reader())

    assert attempts == [Path(path) for path in ("a/01.json", "b/01.json", "c/01.json", "a/02.json")]
    assert [item.file.parent.name for item, _ in examples] == ["b", "c", "a"]
