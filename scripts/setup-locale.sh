#!/bin/sh
# Set character handling only; LANG and LC_ALL also affect dates and numbers.
# An explicit locale is user policy, even when it cannot render tmux Unicode.
aw_locale_is_utf8() {
  # LC_ALL isolates this probe from every inherited locale category.
  _aw_lc_charmap=$(LC_ALL="$1" locale charmap 2>/dev/null) || return 1
  case "$_aw_lc_charmap" in
    [Uu][Tt][Ff]-8|[Uu][Tt][Ff]8) return 0 ;;
    *) return 1 ;;
  esac
}

aw_setup_locale() {
  if ! command -v locale >/dev/null 2>&1; then
    printf '%s\n' 'agent-wrangler: cannot check UTF-8 support: locale utility not found. Install locale support and configure a UTF-8 LC_CTYPE for tmux Unicode.' >&2
    return 0
  fi

  # Empty values are unconfigured. Only the highest-precedence setting matters.
  if [ -n "${LC_ALL:-}" ]; then
    _aw_lc_setting=LC_ALL; _aw_lc_effective=$LC_ALL
  elif [ -n "${LC_CTYPE:-}" ]; then
    _aw_lc_setting=LC_CTYPE; _aw_lc_effective=$LC_CTYPE
  elif [ -n "${LANG:-}" ]; then
    _aw_lc_setting=LANG; _aw_lc_effective=$LANG
  else
    _aw_lc_setting=
  fi
  if [ -n "$_aw_lc_setting" ]; then
    if ! aw_locale_is_utf8 "$_aw_lc_effective"; then
      printf 'agent-wrangler: %s=%s is not a usable UTF-8 locale; preserving it. For tmux Unicode, use locale -a to choose an installed UTF-8 locale and update %s.\n' \
        "$_aw_lc_setting" "$_aw_lc_effective" "$_aw_lc_setting" >&2
    fi
    return 0
  fi

  _aw_lc_available=$(LC_ALL=C locale -a 2>/dev/null) || _aw_lc_available=
  # Prefer neutral UTF-8, then US English, then any usable installed locale.
  # Keep the system's spelling (for example C.utf8) when exporting the result.
  _aw_lc_selected=$(printf '%s\n' "$_aw_lc_available" | LC_ALL=C awk '
    NF {
      name = tolower($0); gsub(/[-_]/, "", name)
      if (name == "c.utf8") preferred[++p] = $0
      else if (name == "enus.utf8") english[++e] = $0
      else other[++n] = $0
    }
    END {
      for (i = 1; i <= p; i++) print preferred[i]
      for (i = 1; i <= e; i++) print english[i]
      for (i = 1; i <= n; i++) print other[i]
    }
  ' | while IFS= read -r _aw_lc_candidate; do
    if aw_locale_is_utf8 "$_aw_lc_candidate"; then
      printf '%s\n' "$_aw_lc_candidate"
      break
    fi
  done)
  if [ -n "$_aw_lc_selected" ]; then
    LC_CTYPE=$_aw_lc_selected
    export LC_CTYPE
  else
    printf '%s\n' 'agent-wrangler: no usable installed UTF-8 locale found; locale settings unchanged. Install or generate a UTF-8 locale, confirm it with locale -a, and set LC_CTYPE to it for tmux Unicode.' >&2
  fi
}

aw_setup_locale
