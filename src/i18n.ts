import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;
let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (_m, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
    return translate(key, fallback, params);
}

const bundles = [
    { locale: "es", namespace: "pi-show-diffs", messages: {
        "cmd.diffApproval": "Activar, desactivar o inspeccionar el modo de aprobación de diffs",
        "cmd.showDiffs": "Alias de /diff-approval",
        "status.auto": "✍ aprobación automática de cambios de archivo",
        "mode.auto": "aprobación automática",
        "mode.manual": "revisión manual",
        "notify.autoOn": "La aprobación automática está ACTIVADA para cambios de archivo.",
        "notify.manualOn": "La revisión manual de diffs está ACTIVADA.",
        "select.turnAutoOff": "Desactivar aprobación automática",
        "select.turnAutoOn": "Activar aprobación automática",
        "select.status": "Mostrar estado",
        "select.cancel": "Cancelar",
        "ui.title": "Revisar cambio de archivo propuesto",
        "ui.titleEdit": "Revisar cambio de archivo propuesto · EDICIÓN INLINE",
        "ui.diff": "Diff:", "ui.view": "Vista:", "ui.context": "Contexto:", "ui.wrap": "Ajuste:", "ui.tool": "Herramienta:", "ui.path": "Ruta:",
        "ui.previewWarning": "Advertencia de vista previa: {message}",
        "ui.original": "Original", "ui.updated": "Actualizado", "ui.updatedEditing": "Actualizado (editando)",
        "ui.footerApprove": "Enter/y aprobar", "ui.footerReject": "r/Esc rechazar", "ui.footerSteer": "s orientar", "ui.footerAuto": "Shift+A auto", "ui.footerEdit": "E editar inline"
    }},
    { locale: "fr", namespace: "pi-show-diffs", messages: {
        "cmd.diffApproval": "Activer, désactiver ou inspecter le mode d’approbation des diffs",
        "cmd.showDiffs": "Alias de /diff-approval",
        "status.auto": "✍ approbation automatique des changements de fichiers",
        "mode.auto": "approbation automatique",
        "mode.manual": "révision manuelle",
        "notify.autoOn": "L’approbation automatique est ACTIVÉE pour les changements de fichiers.",
        "notify.manualOn": "La révision manuelle des diffs est ACTIVÉE.",
        "select.turnAutoOff": "Désactiver l’approbation automatique",
        "select.turnAutoOn": "Activer l’approbation automatique",
        "select.status": "Afficher l’état",
        "select.cancel": "Annuler",
        "ui.title": "Réviser le changement de fichier proposé",
        "ui.titleEdit": "Réviser le changement de fichier proposé · ÉDITION INLINE",
        "ui.diff": "Diff :", "ui.view": "Vue :", "ui.context": "Contexte :", "ui.wrap": "Retour :", "ui.tool": "Outil :", "ui.path": "Chemin :",
        "ui.previewWarning": "Avertissement d’aperçu : {message}",
        "ui.original": "Original", "ui.updated": "Mis à jour", "ui.updatedEditing": "Mis à jour (édition)",
        "ui.footerApprove": "Enter/y approuver", "ui.footerReject": "r/Esc rejeter", "ui.footerSteer": "s orienter", "ui.footerAuto": "Shift+A auto", "ui.footerEdit": "E éditer inline"
    }},
    { locale: "pt-BR", namespace: "pi-show-diffs", messages: {
        "cmd.diffApproval": "Ativar, desativar ou inspecionar o modo de aprovação de diffs",
        "cmd.showDiffs": "Alias para /diff-approval",
        "status.auto": "✍ aprovação automática de mudanças em arquivos",
        "mode.auto": "aprovação automática",
        "mode.manual": "revisão manual",
        "notify.autoOn": "A aprovação automática está ATIVADA para mudanças em arquivos.",
        "notify.manualOn": "A revisão manual de diffs está ATIVADA.",
        "select.turnAutoOff": "Desativar aprovação automática",
        "select.turnAutoOn": "Ativar aprovação automática",
        "select.status": "Mostrar status",
        "select.cancel": "Cancelar",
        "ui.title": "Revisar mudança de arquivo proposta",
        "ui.titleEdit": "Revisar mudança de arquivo proposta · EDIÇÃO INLINE",
        "ui.diff": "Diff:", "ui.view": "Visualização:", "ui.context": "Contexto:", "ui.wrap": "Quebra:", "ui.tool": "Ferramenta:", "ui.path": "Caminho:",
        "ui.previewWarning": "Aviso de prévia: {message}",
        "ui.original": "Original", "ui.updated": "Atualizado", "ui.updatedEditing": "Atualizado (editando)",
        "ui.footerApprove": "Enter/y aprovar", "ui.footerReject": "r/Esc rejeitar", "ui.footerSteer": "s orientar", "ui.footerAuto": "Shift+A auto", "ui.footerEdit": "E editar inline"
    }}
];

export function initI18n(pi: ExtensionAPI): void {
    const events = pi.events;
    if (!events) return;
    for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
    events.emit("pi-core/i18n/requestApi", {
        namespace: "pi-show-diffs",
        callback(api: { t?: Translate } | undefined) {
            if (typeof api?.t === "function") translate = api.t;
        },
    });
}
