import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { PRODUCT_NAME } from "@rakazo/contracts/brand";
import { translate } from "@rakazo/core";
import { messages as de } from "@rakazo/i18n/locales/de/messages.po";
import { messages as en } from "@rakazo/i18n/locales/en/messages.po";
import { messages as es } from "@rakazo/i18n/locales/es/messages.po";
import { messages as fr } from "@rakazo/i18n/locales/fr/messages.po";
import { messages as he } from "@rakazo/i18n/locales/he/messages.po";
import { messages as hi } from "@rakazo/i18n/locales/hi/messages.po";
import { messages as ja } from "@rakazo/i18n/locales/ja/messages.po";
import { messages as ko } from "@rakazo/i18n/locales/ko/messages.po";
import { messages as nl } from "@rakazo/i18n/locales/nl/messages.po";
import { messages as pl } from "@rakazo/i18n/locales/pl/messages.po";
import { messages as ptBR } from "@rakazo/i18n/locales/pt-BR/messages.po";
import { messages as ru } from "@rakazo/i18n/locales/ru/messages.po";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { messages as zhCN } from "@rakazo/i18n/locales/zh-CN/messages.po";
import { messages as zhTW } from "@rakazo/i18n/locales/zh-TW/messages.po";
import { useSyncExternalStore } from "react";
import { installPluralRules } from "./plural-rules";
import type { UiLocale } from "./ui-locale";
import { htmlLangForLocale, resolveUiLocale, UI_LOCALE_STORAGE_KEY } from "./ui-locale";

const catalogs: Record<UiLocale, Messages> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ru,
  de,
  nl,
  ja,
  es,
  pl,
  fr,
  he,
  hi,
  ko,
  "pt-BR": ptBR,
  tr,
};

/** Source descriptors for fork screens still using t(message, values). */
const compatibilityMessages: Record<string, { id: string; message?: string }> = {
  "Close preview": msg`Close preview`,
  "Could not load this file.": msg`Could not load this file.`,
  "Could not share file": msg`Could not share file`,
  Dictate: msg`Dictate`,
  "Listening…": msg`Listening…`,
  "Loading preview…": msg`Loading preview…`,
  Page: msg`Page`,
  Pages: msg`Pages`,
  "Share {name}": msg`Share {name}`,
  "Something went wrong. Try again.": msg`Something went wrong. Try again.`,
  "Try again.": msg`Try again.`,
  cancelled: msg`cancelled`,
  failed: msg`failed`,
  running: msg`running`,
};

/** Fork-only translations retained while those screens move to the shared catalogs. */
const compatibilityTranslations: Partial<Record<UiLocale, Record<string, string>>> = {
  "zh-CN": {
    "Allow bots to use saved passwords directly": "允许 bot 直接使用保存的密码",
    "Background tasks": "后台任务",
    "Background tasks finished": "后台任务已结束",
    "Coordinating background tasks": "正在协调后台任务",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "无法进行语音输入，请检查麦克风和语音识别权限。",
    "Could not preview this file. Share it to open it in another app.":
      "无法预览此文件。请通过分享在其他应用中打开。",
    "Nothing heard. Try again.": "未听到语音，请重试。",
    "Opens the page": "打开页面",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "密码会发送给模型提供商，并可能出现在历史记录中。仅在需要时启用。",
    "Security check failed. Complete it again and retry.": "人机验证未通过，请重新验证后再试。",
    "Sign in to {PRODUCT_NAME}": "登录 {PRODUCT_NAME}",
    "Sign up for {PRODUCT_NAME}": "注册 {PRODUCT_NAME}",
    "Stop dictation": "停止语音输入",
    "That URL did not look like a {PRODUCT_NAME} server": "该地址看起来不是 {PRODUCT_NAME} 服务器",
    "Your administrator manages this setting.": "此设置由管理员统一管理。",
    continuing: "继续中",
    done: "完成",
    "needs you": "等你处理",
    "no progress": "没有进展",
    queued: "排队中",
    "queued #{position}": "排队第 {position} 位",
    starting: "启动中",
    "{count} done": "{count} 个完成",
    "{count} not finished": "{count} 个未完成",
    "{count} running": "{count} 个进行中",
  },
  "zh-TW": {
    "Allow bots to use saved passwords directly": "允許 bot 直接使用儲存的密碼",
    "Background tasks": "背景任務",
    "Background tasks finished": "背景任務已結束",
    "Coordinating background tasks": "正在協調背景任務",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "無法進行語音輸入，請檢查麥克風和語音辨識權限。",
    "Could not preview this file. Share it to open it in another app.":
      "無法預覽此檔案。請透過分享在其他應用中開啟。",
    "Nothing heard. Try again.": "未聽到語音，請重試。",
    "Opens the page": "開啟頁面",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "密碼會傳送給模型供應商，並可能出現在歷史記錄中。僅在需要時啟用。",
    "Security check failed. Complete it again and retry.": "人機驗證未透過，請重新驗證後再試。",
    "Sign in to {PRODUCT_NAME}": "登入 {PRODUCT_NAME}",
    "Sign up for {PRODUCT_NAME}": "註冊 {PRODUCT_NAME}",
    "Stop dictation": "停止語音輸入",
    "That URL did not look like a {PRODUCT_NAME} server": "該地址看起來不是 {PRODUCT_NAME} 伺服器",
    "Your administrator manages this setting.": "此設定由管理員統一管理。",
    continuing: "繼續中",
    done: "完成",
    "needs you": "等你處理",
    "no progress": "沒有進展",
    queued: "排隊中",
    "queued #{position}": "排隊第 {position} 位",
    starting: "啟動中",
    "{count} done": "{count} 個完成",
    "{count} not finished": "{count} 個未完成",
    "{count} running": "{count} 個進行中",
  },
  ru: {
    "Allow bots to use saved passwords directly":
      "Разрешить ботам напрямую использовать сохранённые пароли",
    "Background tasks": "Фоновые задачи",
    "Background tasks finished": "Фоновые задачи завершены",
    "Coordinating background tasks": "Координирую фоновые задачи",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "Не удалось выполнить диктовку. Проверьте разрешения микрофона и распознавания речи.",
    "Could not preview this file. Share it to open it in another app.":
      "Не удалось просмотреть файл. Поделитесь им, чтобы открыть в другом приложении.",
    "Nothing heard. Try again.": "Речь не распознана. Попробуйте ещё раз.",
    "Opens the page": "Открывает страницу",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "Пароли передаются провайдеру модели и могут появиться в истории. Включайте только при необходимости.",
    "Security check failed. Complete it again and retry.":
      "Проверка безопасности не пройдена. Пройдите её снова и повторите попытку.",
    "Sign in to {PRODUCT_NAME}": "Войти в {PRODUCT_NAME}",
    "Sign up for {PRODUCT_NAME}": "Зарегистрироваться в {PRODUCT_NAME}",
    "Stop dictation": "Остановить диктовку",
    "That URL did not look like a {PRODUCT_NAME} server":
      "Этот адрес не похож на сервер {PRODUCT_NAME}",
    "Your administrator manages this setting.": "Этим параметром управляет администратор.",
    continuing: "продолжается",
    done: "готово",
    "needs you": "нужны вы",
    "no progress": "нет прогресса",
    queued: "в очереди",
    "queued #{position}": "в очереди #{position}",
    starting: "запуск",
    "{count} done": "готово: {count}",
    "{count} not finished": "не завершено: {count}",
    "{count} running": "выполняется: {count}",
  },
  de: {
    "Allow bots to use saved passwords directly":
      "Bots dürfen gespeicherte Passwörter direkt verwenden",
    "Background tasks": "Hintergrundaufgaben",
    "Background tasks finished": "Hintergrundaufgaben abgeschlossen",
    "Coordinating background tasks": "Hintergrundaufgaben werden koordiniert",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "Diktieren nicht möglich. Prüfe die Berechtigungen für Mikrofon und Spracherkennung.",
    "Could not preview this file. Share it to open it in another app.":
      "Vorschau nicht möglich. Teile die Datei, um sie in einer anderen App zu öffnen.",
    "Nothing heard. Try again.": "Nichts gehört. Erneut versuchen.",
    "Opens the page": "Öffnet die Seite",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "Passwörter werden an deinen Modellanbieter gesendet und können im Verlauf erscheinen. Nur bei Bedarf aktivieren.",
    "Security check failed. Complete it again and retry.":
      "Sicherheitsprüfung fehlgeschlagen. Schließe sie erneut ab und versuche es noch einmal.",
    "Sign in to {PRODUCT_NAME}": "Bei {PRODUCT_NAME} anmelden",
    "Sign up for {PRODUCT_NAME}": "Bei {PRODUCT_NAME} registrieren",
    "Stop dictation": "Diktat beenden",
    "That URL did not look like a {PRODUCT_NAME} server":
      "Diese URL sieht nicht nach einem {PRODUCT_NAME}-Server aus",
    "Your administrator manages this setting.": "Dein Administrator verwaltet diese Einstellung.",
    continuing: "wird fortgesetzt",
    done: "erledigt",
    "needs you": "braucht dich",
    "no progress": "kein Fortschritt",
    queued: "in Warteschlange",
    "queued #{position}": "Warteschlange #{position}",
    starting: "startet",
    "{count} done": "{count} erledigt",
    "{count} not finished": "{count} nicht abgeschlossen",
    "{count} running": "{count} laufen",
  },
  nl: {
    "Allow bots to use saved passwords directly":
      "Bots opgeslagen wachtwoorden rechtstreeks laten gebruiken",
    "Background tasks": "Achtergrondtaken",
    "Background tasks finished": "Achtergrondtaken klaar",
    "Coordinating background tasks": "Achtergrondtaken worden gecoördineerd",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "Dicteren niet mogelijk. Controleer de machtigingen voor microfoon en spraakherkenning.",
    "Could not preview this file. Share it to open it in another app.":
      "Kan dit bestand niet weergeven. Deel het om het in een andere app te openen.",
    "Nothing heard. Try again.": "Niets gehoord. Probeer het opnieuw.",
    "Opens the page": "Opent de pagina",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "Wachtwoorden worden naar je modelprovider gestuurd en kunnen in de geschiedenis verschijnen. Schakel dit alleen in als het nodig is.",
    "Security check failed. Complete it again and retry.":
      "Beveiligingscontrole mislukt. Voltooi hem opnieuw en probeer het nog eens.",
    "Sign in to {PRODUCT_NAME}": "Aanmelden bij {PRODUCT_NAME}",
    "Sign up for {PRODUCT_NAME}": "Registreer je voor {PRODUCT_NAME}",
    "Stop dictation": "Dicteren stoppen",
    "That URL did not look like a {PRODUCT_NAME} server": "Die URL leek geen {PRODUCT_NAME}-server",
    "Your administrator manages this setting.": "Je beheerder beheert deze instelling.",
    continuing: "bezig door te gaan",
    done: "klaar",
    "needs you": "wacht op jou",
    "no progress": "geen voortgang",
    queued: "in wachtrij",
    "queued #{position}": "wachtrij #{position}",
    starting: "start",
    "{count} done": "{count} klaar",
    "{count} not finished": "{count} niet afgerond",
    "{count} running": "{count} bezig",
  },
  ja: {
    "Allow bots to use saved passwords directly": "ボットによる保存済みパスワードの直接使用を許可",
    "Background tasks": "バックグラウンドタスク",
    "Background tasks finished": "バックグラウンドタスク完了",
    "Coordinating background tasks": "バックグラウンドタスクを調整中",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "音声入力できませんでした。マイクと音声認識の権限を確認してください。",
    "Could not preview this file. Share it to open it in another app.":
      "このファイルはプレビューできません。共有して別のアプリで開いてください。",
    "Nothing heard. Try again.": "音声が聞き取れませんでした。もう一度お試しください。",
    "Opens the page": "ページを開きます",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "パスワードはモデル提供元に送信され、履歴に表示される場合があります。必要な場合のみ有効にしてください。",
    "Security check failed. Complete it again and retry.":
      "セキュリティチェックに失敗しました。もう一度完了してから再試行してください。",
    "Sign in to {PRODUCT_NAME}": "{PRODUCT_NAME}にログイン",
    "Sign up for {PRODUCT_NAME}": "{PRODUCT_NAME}に新規登録",
    "Stop dictation": "音声入力を停止",
    "That URL did not look like a {PRODUCT_NAME} server":
      "そのURLは{PRODUCT_NAME}サーバーではないようです",
    "Your administrator manages this setting.": "この設定は管理者が管理しています。",
    continuing: "続行中",
    done: "完了",
    "needs you": "要対応",
    "no progress": "進捗なし",
    queued: "待機中",
    "queued #{position}": "待機中 #{position}",
    starting: "開始中",
    "{count} done": "{count} 件完了",
    "{count} not finished": "{count} 件未完了",
    "{count} running": "{count} 件実行中",
  },
  es: {
    "Allow bots to use saved passwords directly":
      "Permitir que los bots usen directamente las contraseñas guardadas",
    "Background tasks": "Tareas en segundo plano",
    "Background tasks finished": "Tareas en segundo plano finalizadas",
    "Coordinating background tasks": "Coordinando tareas en segundo plano",
    "Could not dictate. Check microphone and speech recognition permissions.":
      "No se pudo dictar. Revisa los permisos del micrófono y del reconocimiento de voz.",
    "Could not preview this file. Share it to open it in another app.":
      "No se pudo previsualizar este archivo. Compártelo para abrirlo en otra aplicación.",
    "Nothing heard. Try again.": "No se ha oído nada. Inténtalo de nuevo.",
    "Opens the page": "Abre la página",
    "Passwords go to your model provider and may appear in history. Enable only if needed.":
      "Las contraseñas se envían a tu proveedor de modelos y pueden aparecer en el historial. Actívalo solo si es necesario.",
    "Security check failed. Complete it again and retry.":
      "La verificación de seguridad falló. Complétala de nuevo y reinténtalo.",
    "Sign in to {PRODUCT_NAME}": "Inicia sesión en {PRODUCT_NAME}",
    "Sign up for {PRODUCT_NAME}": "Regístrate en {PRODUCT_NAME}",
    "Stop dictation": "Detener dictado",
    "That URL did not look like a {PRODUCT_NAME} server":
      "Esa URL no parece ser un servidor de {PRODUCT_NAME}",
    "Your administrator manages this setting.": "Tu administrador gestiona este ajuste.",
    continuing: "continuando",
    done: "terminado",
    "needs you": "te necesita",
    "no progress": "sin progreso",
    queued: "en cola",
    "queued #{position}": "en cola #{position}",
    starting: "iniciando",
    "{count} done": "{count} terminadas",
    "{count} not finished": "{count} sin terminar",
    "{count} running": "{count} en curso",
  },
};

installPluralRules();
i18n.load(catalogs);
i18n.activate("en");

let activeLocale: UiLocale = "en";
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveUiLocale(): UiLocale {
  return activeLocale;
}

export function dateLocaleForUi(locale: UiLocale = activeLocale): string {
  return locale === "en" ? "en-US" : htmlLangForLocale(locale);
}

/** The app language, re-rendering when it changes. Strings come from Lingui's `useLingui`. */
export function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeI18n, getActiveUiLocale, getActiveUiLocale);
}

/** Compatibility for the fork's screens; upstream screens use Lingui macros directly. */
export function t(message: string, values?: Record<string, string | number>): string {
  const replacements = { PRODUCT_NAME, ...values };
  const descriptor = compatibilityMessages[message];
  if (descriptor)
    return i18n._({ ...descriptor, values: replacements }).replaceAll("Rakazo", PRODUCT_NAME);
  return translate(compatibilityTranslations[activeLocale], message, replacements);
}

export function useI18n(): { locale: UiLocale; t: typeof t } {
  return { locale: useUiLocale(), t };
}

export function activateUiLocale(locale: UiLocale): UiLocale {
  activeLocale = locale;
  i18n.activate(locale);
  emit();
  return locale;
}

async function applyDirection(locale: UiLocale): Promise<void> {
  try {
    // Direction follows the active UI locale only (all supported locales are LTR), never the
    // device language. Applying device RTL here would fight this and reload-loop.
    const { applyMobileUiDirection } = await import("./ui-direction");
    applyMobileUiDirection(htmlLangForLocale(locale));
  } catch {
    // Tests and some hosts have no native direction APIs.
  }
}

/** The device's preferred language (`es-CL`), from Expo where it loads, else from Intl. */
export async function deviceLanguage(): Promise<string | null> {
  // Lazy: nearly every module imports i18n, including ones evaluated without native modules.
  try {
    const localization = await import("expo-localization");
    const tag = localization.getLocales()[0]?.languageTag;
    if (typeof tag === "string" && tag) return tag;
  } catch {
    // Keep Intl fallback.
  }
  try {
    const IntlRef = globalThis.Intl;
    return IntlRef?.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

export async function bootstrapI18n(): Promise<UiLocale> {
  let stored: string | null = null;
  // Lazy: nearly every module imports i18n, including ones evaluated without native modules.
  try {
    const SecureStore = await import("expo-secure-store");
    stored = await SecureStore.getItemAsync(UI_LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const envDefault =
    typeof process !== "undefined" && typeof process.env.EXPO_PUBLIC_DEFAULT_UI_LOCALE === "string"
      ? process.env.EXPO_PUBLIC_DEFAULT_UI_LOCALE
      : null;
  const locale = resolveUiLocale({ stored, envDefault, deviceLanguage: await deviceLanguage() });
  activateUiLocale(locale);
  await applyDirection(locale);
  return locale;
}

export async function persistUiLocale(locale: UiLocale): Promise<void> {
  try {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore SecureStore failures; in-memory locale still applies.
  }
}

/** Serialize SecureStore writes so rapid picker taps apply in order (last wins). */
let uiLocaleWriteChain: Promise<void> = Promise.resolve();

export async function setUiLocale(locale: UiLocale): Promise<UiLocale> {
  const write = uiLocaleWriteChain.then(async () => {
    await persistUiLocale(locale);
    activateUiLocale(locale);
    await applyDirection(locale);
    return locale;
  });
  uiLocaleWriteChain = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

/** Test-only: set the in-memory locale without I/O. */
export function resetI18nForTests(locale: UiLocale = "en"): void {
  activeLocale = locale;
  i18n.activate(locale);
  uiLocaleWriteChain = Promise.resolve();
  emit();
}
