#!/usr/bin/env python3
"""Les enregistrements de la musique du launcher → OGG Vorbis du mod.

Coupe la montée du début, pose un fondu d'entrée et de sortie, normalise, et
écrit `mod/src/main/resources/assets/opm/sounds/music/xenodys_<état>.ogg`.
Demande `pip install soundfile numpy` (libsndfile sait écrire le Vorbis).
"""

from pathlib import Path

import numpy as np
import soundfile as sf

ICI = Path(__file__).resolve().parent
SORTIE = ICI.parent.parent / "mod" / "src" / "main" / "resources" / "assets" / "opm" / "sounds" / "music"

for etat in ("creatrice", "corrompue"):
    data, rate = sf.read(ICI / f"{etat}.wav", dtype="float32")
    data = data[int(rate * 4):]  # la montée du volume du launcher
    n = len(data)
    fade_in, fade_out = int(rate * 3), int(rate * 5)
    env = np.ones(n, dtype=np.float32)
    env[:fade_in] = np.linspace(0, 1, fade_in) ** 2
    env[-fade_out:] = np.linspace(1, 0, fade_out) ** 2
    data = data * env[:, None]
    data *= 0.85 / max(1e-6, float(np.abs(data).max()))
    SORTIE.mkdir(parents=True, exist_ok=True)
    data = np.ascontiguousarray(data, dtype=np.float32)
    # Par blocs : libsndfile plante sur un seul gros bloc Vorbis.
    with sf.SoundFile(SORTIE / f"xenodys_{etat}.ogg", "w", rate, data.shape[1], format="OGG", subtype="VORBIS") as f:
        for i in range(0, n, 4096):
            f.write(data[i : i + 4096])
    print(etat, round(n / rate, 1), "s")
