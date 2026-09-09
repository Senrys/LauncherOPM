# ---------------------------------------------------------------------------
# Serveur d'authentification One Piece Minecraft — image de production.
#
# Deux étapes :
#   1. « builder » installe les dépendances dans un environnement virtuel ;
#   2. l'image finale ne reçoit que cet environnement et le code. Ni compilateur,
#      ni en-têtes de développement, ni cache pip ne s'y retrouvent.
#
# Ce que l'image NE contient PAS, volontairement :
#   - aucune clé privée (montez « keys/ » en volume : cf. docker-compose.yml) ;
#   - aucun fichier .env ni secret (tout passe par l'environnement) ;
#   - aucune base de données. La base est celle du SITE : le conteneur s'y
#     connecte par OPM_DATABASE_URL, il n'en héberge pas une seconde.
#
# Construction :   docker build -t opm-auth:1.0.0 .
# Exécution       : voir docker-compose.yml
# ---------------------------------------------------------------------------

# ============================ 1. Construction ==============================
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

# Compilateur et en-têtes : la plupart des dépendances ont des roues
# précompilées, mais une architecture exotique (ARM, musl) peut avoir à
# construire cryptography ou asyncpg. Ces paquets restent dans cette étape et
# n'atteignent jamais l'image finale.
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Les dépendances d'abord : cette couche est réutilisée tant que
# requirements.txt ne change pas, ce qui rend les reconstructions instantanées.
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt


# ============================ 2. Image finale ==============================
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="OPM Auth" \
      org.opencontainers.image.description="Serveur d'authentification souverain (Yggdrasil maison) du serveur One Piece Minecraft" \
      org.opencontainers.image.vendor="One Piece Minecraft" \
      org.opencontainers.image.licenses="Proprietary"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    OPM_HOST=0.0.0.0 \
    OPM_PORT=8000 \
    OPM_TEXTURES_DIR=/app/data/textures \
    OPM_JWT_PRIVATE_KEY_PATH=/app/keys/jwt_ed25519_private.pem \
    OPM_JWT_PUBLIC_KEY_PATH=/app/keys/jwt_ed25519_public.pem \
    OPM_YGG_PRIVATE_KEY_PATH=/app/keys/ygg_rsa_private.pem \
    OPM_YGG_PUBLIC_KEY_PATH=/app/keys/ygg_rsa_public.pem

# Utilisateur non privilégié : le serveur n'a besoin d'écrire que dans
# /app/keys et /app/data. Un conteneur qui tourne en root n'apporte rien ici,
# sinon le risque qu'une faille se transforme en compromission de l'hôte.
RUN groupadd --gid 10001 opm \
    && useradd --uid 10001 --gid opm --home-dir /app --no-create-home --shell /usr/sbin/nologin opm

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv

# Le code applicatif et de quoi migrer la base depuis le conteneur.
COPY --chown=opm:opm opm_auth/ ./opm_auth/
COPY --chown=opm:opm migrations/ ./migrations/
COPY --chown=opm:opm alembic.ini pyproject.toml requirements.txt ./

# Points de montage : clés privées d'un côté, textures de l'autre. Ils sont
# créés ici avec les bons droits pour qu'un volume vide fonctionne du premier coup.
RUN mkdir -p /app/keys /app/data/textures && chown -R opm:opm /app/keys /app/data
VOLUME ["/app/keys", "/app/data"]

USER opm
EXPOSE 8000

# Sonde native : /health interroge réellement la base (SELECT 1) et répond 503
# si elle ne répond pas. « start-period » laisse le temps à la première
# génération de la clé RSA-4096, qui prend quelques secondes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import sys,urllib.request;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"

# Un seul processus par conteneur : la mise à l'échelle se fait par réplicas,
# et les tâches de fond (ping du serveur, purge) ne doivent pas tourner en
# double dans un même conteneur.
#
# ATTENTION à « --forwarded-allow-ips * » : il fait confiance à l'en-tête
# X-Forwarded-For de l'appelant direct. C'est indispensable derrière nginx
# (sans quoi tous les joueurs partageraient l'adresse du répartiteur, et donc
# ses quotas), et dangereux si le port 8000 du conteneur est publié tel quel
# sur Internet. Publiez-le sur 127.0.0.1 uniquement (docker-compose.yml le fait)
# et laissez nginx écouter en façade. Le réglage applicatif correspondant est
# OPM_TRUST_PROXY_HEADERS=true.
CMD ["uvicorn", "opm_auth.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
