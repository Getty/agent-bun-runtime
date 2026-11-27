:<<"::getty-bun-sh"
@echo off
rem getty-bun.cmd: the polyglot of Getty's Bun runtime for Claude Code hooks in shell
rem form, docs/adr/0010 in getty-bun. It holds no pin and picks no version. As a batch
rem file, run by cmd.exe when PowerShell or cmd calls it, it runs the getty-bun.ps1 next
rem to it under Windows PowerShell 5.1 by its absolute path, never one found in the
rem working directory, with the arguments as given and exits with its exit code. Keep
rem this part free of labels, goto and blocks: the file has LF line endings.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0getty-bun.ps1" %*
exit /b %ERRORLEVEL%
::getty-bun-sh
# POSIX side: a shell dot-sourcing this file (". <root>/bootstrap/getty-bun.cmd run
# <entry> [args...]") skips the batch part above as a here-document and runs this part,
# which hands the call to the getty-bun.sh next to this file with "sh", by exec. Contract,
# the hook line and what each shell supports: bootstrap/README.md, "Polyglot".
#
# dash's "." ignores the arguments after the file name. When the shell's own command line
# is "<sh> -c '. <file> <args>'" (a hook in shell form) and its first word after the "."
# names getty-bun.cmd, that line runs again under bash, whose "." passes them; never
# anything but such a line (what came before it would run twice), never from bash or zsh.
if [ "$#" -eq 0 ] && [ -z "${BASH_VERSION-}${ZSH_VERSION-}" ]; then
  _gb_c=
  if [ -r "/proc/$$/cmdline" ] && command -v bash >/dev/null 2>&1 && command -v xargs >/dev/null 2>&1; then
    # shellcheck disable=SC2016 # expanded by the inner sh
    _gb_c=$(xargs -0 sh -c 'case $2 in -*c*) printf "%sx" "$3" ;; esac' sh <"/proc/$$/cmdline" 2>/dev/null) || _gb_c=
    _gb_c=${_gb_c%x}
  fi
  _gb_t=${_gb_c#"${_gb_c%%[! 	]*}"}
  case $_gb_t in
    '. '*)
      # The word after ". ": a double- or single-quoted string or an unquoted word, the
      # quoted string optionally followed by unquoted text, then a blank or the line's end.
      _gb_t=${_gb_t#. }
      _gb_t=${_gb_t#"${_gb_t%%[! 	]*}"}
      case $_gb_t in
        \"*) _gb_w=${_gb_t#\"}; _gb_w=${_gb_w%%\"*}; _gb_r=${_gb_t#\"}; _gb_r=${_gb_r#"$_gb_w"}; _gb_r=${_gb_r#\"} ;;
        \'*) _gb_w=${_gb_t#\'}; _gb_w=${_gb_w%%\'*}; _gb_r=${_gb_t#\'}; _gb_r=${_gb_r#"$_gb_w"}; _gb_r=${_gb_r#\'} ;;
        *) _gb_w=${_gb_t%%[ 	;&|<>()\"\'\`]*}; _gb_r=${_gb_t#"$_gb_w"} ;;
      esac
      _gb_x=${_gb_r%%[ 	;&|<>()\"\'\`]*}
      _gb_w=$_gb_w$_gb_x
      _gb_r=${_gb_r#"$_gb_x"}
      case $_gb_r in
        '' | [' 	']*)
          case $_gb_w in
            getty-bun.cmd | *[/\\]getty-bun.cmd) exec bash -c "$_gb_c" ;;
          esac
          ;;
      esac
      ;;
  esac
  printf 'getty-bun: getty-bun.cmd got no arguments; this shell passes none to a dot-sourced file (dash), and bash cannot take over here (it needs /proc, bash, xargs and a command line "sh -c %s" whose first word after the dot names getty-bun.cmd)\n' \
    "'. <file> <args>'" >&2
  exit 1
fi
# This file's directory: bash names a sourced file in BASH_SOURCE, zsh in $0, and $0 is
# this file when a shell runs it as a script; BusyBox sh names it nowhere, so there it is
# the bootstrap directory of CLAUDE_PLUGIN_ROOT.
_gb_d=
# shellcheck disable=SC3028 # BASH_SOURCE is read on purpose; unset outside bash
for _gb_f in "${BASH_SOURCE-}" "$0"; do
  case $_gb_f in
    getty-bun.cmd) _gb_d=. ;;
    *[/\\]getty-bun.cmd) _gb_d=${_gb_f%[/\\]*} ;;
    *) continue ;;
  esac
  break
done
if [ -z "$_gb_d" ] && [ -n "${CLAUDE_PLUGIN_ROOT-}" ]; then
  _gb_d=$CLAUDE_PLUGIN_ROOT/bootstrap
fi
if [ -z "$_gb_d" ] || [ ! -f "$_gb_d/getty-bun.sh" ]; then
  printf 'getty-bun: getty-bun.cmd cannot find the getty-bun.sh next to it (looked in: %s; CLAUDE_PLUGIN_ROOT: %s)' \
    "${_gb_d:-nothing, this shell does not name a dot-sourced file}" "${CLAUDE_PLUGIN_ROOT:-not set}" | tr '\r\n\t' '   ' >&2
  printf '\n' >&2
  exit 1
fi
exec sh "$_gb_d/getty-bun.sh" "$@"
