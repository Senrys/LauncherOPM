"""Envoi de courriels — réinitialisation de mot de passe et vérification d'adresse.

Deux messages seulement, et c'est volontaire : un serveur d'authentification qui
envoie des lettres d'information finit par se faire classer en indésirable, ce
qui ferait tomber les seuls courriels qui comptent vraiment.

Comment l'envoi est asynchrone
==============================

Il n'y a **aucune dépendance SMTP supplémentaire** : le module utilise
``smtplib`` de la bibliothèque standard, exécuté dans un fil d'exécution par
:func:`asyncio.to_thread`. La boucle d'événements n'est donc jamais bloquée par
une poignée de main TLS lente, et le projet ne gagne pas un paquet de plus à
maintenir pour deux messages par jour.

Mode développement
==================

Quand ``OPM_SMTP_ENABLED`` est faux ou ``OPM_SMTP_HOST`` vide, rien n'est
envoyé : le message est **écrit dans le journal**, en clair, pour qu'on puisse
copier le code de réinitialisation pendant les essais. Cette impression n'a lieu
qu'en dehors de la production (``OPM_ENV != prod``) : en production, un SMTP
absent produit un avertissement **sans le corps du message**, car un jeton en
clair n'a rien à faire dans un journal (``docs/API.md`` §4.8).

Branchement
===========

.. code-block:: python

    from opm_auth.services import mailer

    mailer.install()   # au démarrage de l'application (lifespan)

:func:`install` déclare ce module comme transporteur des liens de
réinitialisation auprès de :mod:`opm_auth.services.users`. Sans cet appel, les
jetons sont bien créés mais ne sont remis à personne.

Charte graphique
================

Les gabarits reprennent les couleurs de la maquette : encre ``#0F1A19``,
aqua ``#91D9D1``, papier ``#F2FAF8``. Mise en page par tableaux et styles en
ligne — c'est laid à écrire, mais c'est le seul HTML que les clients de
messagerie affichent correctement. Chaque message part avec une version texte
équivalente, jamais un simple « activez le HTML ».
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import TYPE_CHECKING, Any

from opm_auth.config import Settings, get_settings

if TYPE_CHECKING:  # pragma: no cover - uniquement pour les outils d'analyse
    from opm_auth.models import User

logger = logging.getLogger(__name__)

__all__ = [
    "AQUA",
    "INK",
    "PAPER",
    "Mail",
    "install",
    "render_email_verification",
    "render_password_reset",
    "send",
    "send_email_verification",
    "send_password_reset",
    "set_transport",
    "uninstall",
]

# --------------------------------------------------------------------------- #
# Charte : les trois couleurs de la maquette
# --------------------------------------------------------------------------- #

#: Encre — fonds sombres, texte principal.
INK = "#0F1A19"
#: Aqua — accents, boutons, encadrés.
AQUA = "#91D9D1"
#: Papier — fond des messages.
PAPER = "#F2FAF8"
#: Vert profond, pour les intertitres (dérivé de la maquette).
DEEP = "#1D5C51"
#: Gris-vert des mentions secondaires.
MUTED = "#5B6E6A"

#: Nom du serveur affiché dans les messages, à défaut de configuration.
_DEFAULT_SERVER_NAME = "One Piece Minecraft"


# --------------------------------------------------------------------------- #
# Objet message
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Mail:
    """Un courriel prêt à partir, dans ses deux versions.

    :ivar to: adresse du destinataire.
    :ivar subject: objet, en français.
    :ivar text: version texte brut — celle que lisent les clients austères et
        les lecteurs d'écran.
    :ivar html: version HTML, mise en page par tableaux et styles en ligne.
    """

    to: str
    subject: str
    text: str
    html: str

    def to_message(self, settings: Settings | None = None) -> EmailMessage:
        """Construit l'objet ``EmailMessage`` correspondant."""
        config = settings or get_settings()
        message = EmailMessage()
        message["Subject"] = self.subject
        message["From"] = formataddr(
            (config.smtp_from_name or _DEFAULT_SERVER_NAME, config.smtp_from)
        )
        message["To"] = self.to
        message["Message-ID"] = make_msgid()
        # Un courriel transactionnel ne doit jamais déclencher de réponse
        # automatique (absence du bureau, accusé de réception…).
        message["Auto-Submitted"] = "auto-generated"
        message.set_content(self.text, subtype="plain", charset="utf-8")
        message.add_alternative(self.html, subtype="html", charset="utf-8")
        return message


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #

#: Signature d'un transport : il reçoit le message assemblé et l'achemine.
Transport = Callable[[EmailMessage], Awaitable[None]]

_transport: Transport | None = None


def set_transport(transport: Transport | None) -> None:
    """Remplace le transport SMTP. **Réservé aux tests.**

    .. code-block:: python

        boite: list[EmailMessage] = []
        mailer.set_transport(lambda message: boite.append(message) or asyncio.sleep(0))
    """
    global _transport
    _transport = transport


def _smtp_available(settings: Settings) -> bool:
    """Un serveur SMTP est-il réellement configuré ?"""
    return bool(settings.smtp_enabled and settings.smtp_host.strip())


def _send_blocking(message: EmailMessage, settings: Settings) -> None:
    """Envoi SMTP synchrone, exécuté hors de la boucle d'événements."""
    host = settings.smtp_host.strip()
    port = settings.smtp_port
    timeout = settings.smtp_timeout_seconds

    if settings.smtp_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            host, port, timeout=timeout, context=ssl.create_default_context()
        )
    else:
        server = smtplib.SMTP(host, port, timeout=timeout)

    with server:
        server.ehlo()
        if settings.smtp_starttls and not settings.smtp_ssl:
            server.starttls(context=ssl.create_default_context())
            server.ehlo()
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(message)


def _log_instead_of_sending(mail: Mail, settings: Settings) -> None:
    """Trace le message quand aucun SMTP n'est configuré.

    En développement, le corps complet est écrit : c'est ainsi qu'on récupère le
    code de réinitialisation sans serveur de messagerie. En production, on se
    contente de dire qu'un message n'a pas pu partir — le corps contient un
    jeton, et un jeton en clair n'entre pas dans un journal.
    """
    if settings.is_prod:
        logger.error(
            "Aucun SMTP configuré : le message « %s » destiné à %s n'a pas été envoyé. "
            "Renseignez OPM_SMTP_ENABLED et OPM_SMTP_HOST.",
            mail.subject,
            mail.to,
        )
        return

    logger.info(
        "\n"
        "┌─ COURRIEL NON ENVOYÉ (aucun SMTP configuré) ─────────────────────────\n"
        "│ À      : %s\n"
        "│ Objet  : %s\n"
        "├──────────────────────────────────────────────────────────────────────\n"
        "%s\n"
        "└──────────────────────────────────────────────────────────────────────",
        mail.to,
        mail.subject,
        mail.text,
    )


async def send(mail: Mail, *, settings: Settings | None = None) -> bool:
    """Achemine un message. **Ne lève jamais.**

    Un courriel qui ne part pas ne doit pas faire échouer la requête qui l'a
    déclenché : ``POST /auth/password/forgot`` répond ``202`` dans tous les cas
    (``docs/API.md`` §1.2), y compris quand le relais SMTP est en panne.

    :returns: vrai si le message a effectivement été confié à un transport.
    """
    config = settings or get_settings()

    if _transport is not None:
        try:
            await _transport(mail.to_message(config))
            return True
        except Exception:  # un transport de test ne doit rien casser
            logger.exception("Le transport de courriel a échoué.")
            return False

    if not _smtp_available(config):
        _log_instead_of_sending(mail, config)
        return False

    try:
        await asyncio.to_thread(_send_blocking, mail.to_message(config), config)
    except asyncio.CancelledError:
        raise
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        # On journalise l'objet et le destinataire, jamais le corps : il porte
        # le jeton de réinitialisation.
        logger.error(
            "Envoi du courriel « %s » à %s impossible : %s", mail.subject, mail.to, exc
        )
        return False

    logger.info("Courriel « %s » envoyé à %s.", mail.subject, mail.to)
    return True


# --------------------------------------------------------------------------- #
# Gabarits
# --------------------------------------------------------------------------- #


def _escape(value: Any) -> str:
    """Échappe une valeur avant insertion dans le HTML du message."""
    text = "" if value is None else str(value)
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _server_name(settings: Settings) -> str:
    """Nom du serveur, tel qu'il apparaît en en-tête du message."""
    return settings.server_name.strip() or _DEFAULT_SERVER_NAME


def _validity(expires_at: datetime | None, settings: Settings) -> str:
    """Phrase indiquant la durée de validité, en français et sans jargon."""
    minutes = settings.password_reset_ttl_minutes
    if expires_at is not None:
        minutes = max(1, round((expires_at - datetime.now(expires_at.tzinfo)).total_seconds() / 60))
    if minutes >= 120:
        heures = round(minutes / 60)
        return f"{heures} heures"
    if minutes >= 60:
        return "1 heure"
    return f"{minutes} minutes"


def _optional_url(settings: Settings, attribute: str, token: str) -> str | None:
    """Construit une URL d'action si le réglage correspondant existe.

    ``config.py`` n'expose pour l'instant **aucune** page web de réinitialisation
    : le message donne donc le code à recopier dans le launcher. Le jour où un
    réglage ``OPM_PASSWORD_RESET_URL`` (ou ``OPM_EMAIL_VERIFICATION_URL``) sera
    ajouté, ce lien apparaîtra tout seul — d'où la lecture défensive plutôt
    qu'un chemin inventé qui mènerait à une page 404.
    """
    template = str(getattr(settings, attribute, "") or "").strip()
    if not template:
        return None
    separator = "&" if "?" in template else "?"
    return f"{template}{separator}token={token}"


def _html_shell(
    *,
    settings: Settings,
    title: str,
    intro: str,
    code: str,
    code_label: str,
    action_url: str | None,
    action_label: str,
    outro: str,
) -> str:
    """Enveloppe HTML commune aux deux messages, aux couleurs de la maquette."""
    server = _escape(_server_name(settings))
    website = settings.link_website.strip()

    bouton = ""
    if action_url:
        bouton = f"""
              <tr><td style="padding:0 0 22px 0">
                <a href="{_escape(action_url)}"
                   style="display:inline-block;background:{INK};color:{AQUA};
                          font:700 14px/1 Arial,Helvetica,sans-serif;letter-spacing:.06em;
                          text-decoration:none;padding:16px 26px;border-radius:8px">
                  {_escape(action_label)}
                </a>
              </td></tr>"""

    pied_site = ""
    if website:
        pied_site = (
            f'<a href="{_escape(website)}" style="color:{DEEP};text-decoration:underline">'
            f"{_escape(website)}</a><br>"
        )

    return f"""<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_escape(title)}</title></head>
<body style="margin:0;padding:0;background:{PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:{PAPER};padding:28px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:560px;background:#FFFFFF;border:1px solid #DEEDE9;border-radius:12px;
                  overflow:hidden">

      <tr><td style="background:{INK};padding:22px 28px">
        <div style="font:700 10px Arial,Helvetica,sans-serif;letter-spacing:.22em;color:{AQUA}">
          {server.upper()}
        </div>
        <div style="font:700 24px/1.1 Arial,Helvetica,sans-serif;color:{PAPER};padding-top:8px">
          {_escape(title)}
        </div>
      </td></tr>

      <tr><td style="padding:26px 28px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="font:400 15px/1.6 Arial,Helvetica,sans-serif;color:{INK};
                         padding-bottom:20px">
            {_escape(intro)}
          </td></tr>

          <tr><td style="padding-bottom:22px">
            <div style="font:700 10px Arial,Helvetica,sans-serif;letter-spacing:.18em;
                        color:{DEEP};padding-bottom:8px">{_escape(code_label)}</div>
            <div style="background:{AQUA};border-radius:8px;padding:16px 18px;
                        font:700 20px/1.3 'Courier New',Courier,monospace;color:{INK};
                        word-break:break-all">{_escape(code)}</div>
          </td></tr>
{bouton}
          <tr><td style="font:400 13px/1.6 Arial,Helvetica,sans-serif;color:{MUTED};
                         padding-bottom:26px">
            {_escape(outro)}
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="background:{PAPER};border-top:1px solid #DEEDE9;padding:18px 28px;
                     font:400 12px/1.6 Arial,Helvetica,sans-serif;color:{MUTED}">
        {pied_site}Message automatique — merci de ne pas y répondre.
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>"""


def render_password_reset(
    user: User,
    token: str,
    expires_at: datetime | None = None,
    *,
    settings: Settings | None = None,
) -> Mail:
    """Compose le message de réinitialisation de mot de passe."""
    config = settings or get_settings()
    server = _server_name(config)
    pseudo = getattr(user, "name", None) or "moussaillon"
    validite = _validity(expires_at, config)
    lien = _optional_url(config, "password_reset_url", token)

    intro = (
        f"Bonjour {pseudo}, une réinitialisation de mot de passe a été demandée pour "
        f"votre compte {server}. Recopiez le code ci-dessous dans le launcher, écran "
        "« Mot de passe oublié »."
    )
    outro = (
        f"Ce code est valable {validite} et ne sert qu'une fois. "
        "Si vous n'êtes à l'origine d'aucune demande, ignorez ce message : votre mot de "
        "passe actuel reste valable et personne d'autre n'a reçu ce code."
    )

    text_lines = [
        f"{server} — Réinitialisation de votre mot de passe",
        "",
        intro,
        "",
        f"Code : {token}",
    ]
    if lien:
        text_lines += ["", f"Ou ouvrez directement : {lien}"]
    text_lines += ["", outro, "", "Message automatique — merci de ne pas y répondre."]

    return Mail(
        to=user.email,
        subject=f"{server} — Réinitialisation de votre mot de passe",
        text="\n".join(text_lines),
        html=_html_shell(
            settings=config,
            title="Réinitialisation du mot de passe",
            intro=intro,
            code=token,
            code_label="VOTRE CODE",
            action_url=lien,
            action_label="CHOISIR UN NOUVEAU MOT DE PASSE",
            outro=outro,
        ),
    )


def render_email_verification(
    user: User,
    token: str,
    expires_at: datetime | None = None,
    *,
    settings: Settings | None = None,
) -> Mail:
    """Compose le message de vérification d'adresse électronique."""
    config = settings or get_settings()
    server = _server_name(config)
    pseudo = getattr(user, "name", None) or "moussaillon"
    validite = _validity(expires_at, config)
    lien = _optional_url(config, "email_verification_url", token)

    intro = (
        f"Bienvenue à bord, {pseudo}. Confirmez cette adresse pour terminer la création "
        f"de votre compte {server} : recopiez le code ci-dessous dans le launcher."
    )
    outro = (
        f"Ce code est valable {validite}. "
        "Si vous n'avez pas créé de compte, ignorez ce message : aucune adresse n'est "
        "confirmée sans ce code."
    )

    text_lines = [
        f"{server} — Confirmez votre adresse e-mail",
        "",
        intro,
        "",
        f"Code : {token}",
    ]
    if lien:
        text_lines += ["", f"Ou ouvrez directement : {lien}"]
    text_lines += ["", outro, "", "Message automatique — merci de ne pas y répondre."]

    return Mail(
        to=user.email,
        subject=f"{server} — Confirmez votre adresse e-mail",
        text="\n".join(text_lines),
        html=_html_shell(
            settings=config,
            title="Confirmation de l'adresse e-mail",
            intro=intro,
            code=token,
            code_label="VOTRE CODE",
            action_url=lien,
            action_label="CONFIRMER MON ADRESSE",
            outro=outro,
        ),
    )


# --------------------------------------------------------------------------- #
# Points d'entrée
# --------------------------------------------------------------------------- #


async def send_password_reset(user: User, token: str, expires_at: datetime) -> None:
    """Transporteur branché sur :mod:`opm_auth.services.users`.

    La signature est imposée par ``users.PasswordResetSender`` : compte, jeton en
    clair, date d'expiration. Le jeton ne traverse ce module que pour être mis en
    forme — il n'est ni conservé, ni journalisé en production.
    """
    await send(render_password_reset(user, token, expires_at))


async def send_email_verification(user: User, token: str, expires_at: datetime) -> None:
    """Envoie le message de confirmation d'adresse."""
    await send(render_email_verification(user, token, expires_at))


def install() -> None:
    """Branche ce module comme transporteur des courriels du serveur.

    À appeler une fois au démarrage (``lifespan`` de l'application). Sans cet
    appel, ``users.request_password_reset`` crée bien le jeton mais ne le remet
    à personne, et le joueur n'a aucun moyen de retrouver son compte.
    """
    from opm_auth.services import users

    users.set_password_reset_sender(send_password_reset)
    settings = get_settings()
    if _smtp_available(settings):
        logger.info(
            "Courriels actifs : %s:%s (expéditeur %s).",
            settings.smtp_host,
            settings.smtp_port,
            settings.smtp_from,
        )
    else:
        logger.warning(
            "Aucun SMTP configuré : les courriels seront %s.",
            "écrits dans le journal" if not settings.is_prod else "perdus",
        )


def uninstall() -> None:
    """Débranche le transporteur (arrêt de l'application, tests)."""
    from opm_auth.services import users

    users.set_password_reset_sender(None)
