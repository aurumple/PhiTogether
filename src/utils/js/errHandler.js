import shared from "@utils/js/shared";
import { msgHandler } from "@utils/js/msgHandler";
import { getConstructorName } from "@utils/js/common";
import { Utils } from "@utils/js/utils";
import ploading from "@utils/js/ploading.js";
import { moduleMode } from "app-view";

const errsToReport = [];

/** @param {Error} error */
const sysError = (e, error, message) => {
    const type = getConstructorName(error);
    let message2 = String(error);
    let detail = String(error);
    if (error instanceof Error) {
        const stack = error.stack || "Stack not available";
        if (error.name === type) message2 = error.message;
        else message2 = `${error.name}: ${error.message}`;
        const idx = stack.indexOf(message2) + 1;
        if (idx) detail = `${message2}\n${stack.slice(idx + message2.length)}`;
        else detail = `${message2}\n    ${stack.split("\n").join("\n    ")}`; //Safari
    }
    if (message) message2 = message;
    const errMessage = `[${type}] ${message2.split("\n")[0]}`;
    const errDetail = `[${type}] ${detail}`;
    if (/(orientation|Decoding)/.test(errMessage)) return;
    ploading.r();
    msgHandler.sendError(errMessage, Utils.escapeHTML(errDetail));

    try {
        const formData = new FormData();

        formData.append("page", shared.game.ptmain.$route.fullPath);
        formData.append("file", e.filename);
        formData.append("msg", error.message);
        formData.append("stack", error.stack);
        formData.append("ver", window.spec.thisVersion);
        formData.append(
            "uid",
            shared.game.ptmain.gameConfig.account.userBasicInfo
                ? shared.game.ptmain.gameConfig.account.userBasicInfo.id.toString()
                : "0"
        );

        // 模块模式不外发：局域网产品不连公网（容器 CSP 也只放行同源），错误只做本机提示。
        if (moduleMode) {
            // 丢弃上报载荷；errsToReport 保持为空，“online” 重发循环自然无事可做。
        } else if (navigator.onLine)
            fetch(`https://api.phitogether.realtvop.top/errReport`, {
                method: "POST",
                body: formData,
            }).catch(e => e);
        else errsToReport.push(formData);
    } catch (err) {
        // shit
        console.log(err);
    }
};
self.addEventListener("error", e => sysError(e, e.error, e.message));
self.addEventListener("unhandledrejection", e => sysError(e, e.reason));

window.addEventListener("online", () => {
    for (const formData of errsToReport) {
        try {
            if (formData) {
                fetch(`https://api.phitogether.realtvop.top/errReport`, {
                    method: "POST",
                    body: formData,
                })
                    .then(() => (errsToReport[errsToReport.indexOf(formData)] = null))
                    .catch(e => e);
            }
        } catch (err) {
            // damn
        }
    }
});

window.addEventListener("load", event => {
    // 在线人数探测只在独立版发；模块模式不连公网。
    if (!moduleMode) fetch(`https://api.phitogether.realtvop.top/t/o`).catch(e => e);
});
