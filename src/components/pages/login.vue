<script>
    import ploading from "@utils/js/ploading.js";
    import shared from "@utils/js/shared";
    import * as serverApi from "@utils/serverApi";

    // 自建服务端登录/注册（替代原 PhiZone 账号体系）。
    // 成功后把用户信息写回 ptmain（applyServerUser），游客模式不登录也可游玩，
    // 但成绩只存本地、不上传排行榜。
    export default {
        name: "login",
        data() {
            return {
                mode: "login", // login | register
                username: "",
                password: "",
                confirmPassword: "",
                nickname: "",
                busy: false,
            };
        },
        methods: {
            switchMode() {
                this.mode = this.mode === "login" ? "register" : "login";
            },
            async doSubmit() {
                const msgHandler = shared.game.msgHandler;
                if (!this.username || !this.password) {
                    msgHandler.sendMessage(
                        this.$t("login.usernameAndPasswordCantBeEmpty"),
                        "error"
                    );
                    return;
                }
                if (this.mode === "register" && this.password !== this.confirmPassword) {
                    msgHandler.sendMessage(this.$t("login.passwordMismatch"), "error");
                    return;
                }
                if (this.busy) return;
                this.busy = true;
                ploading.l(this.$t("login.loggingin"), "login");
                try {
                    const user =
                        this.mode === "login"
                            ? await serverApi.login(this.username, this.password)
                            : await serverApi.register({
                                  username: this.username,
                                  password: this.password,
                                  confirm_password: this.confirmPassword,
                                  nickname: this.nickname || undefined,
                              });
                    shared.game.ptmain.applyServerUser(user);
                    msgHandler.sendMessage(
                        this.$t("login.success", { userName: user.nickname || user.username }),
                        "success",
                        true
                    );
                    this.$router.push("/startPage");
                } catch (e) {
                    msgHandler.failure(e && e.message ? e.message : this.$t("login.failed"));
                } finally {
                    ploading.r("login");
                    this.busy = false;
                }
            },
            playAsGuest() {
                this.$router.push("/startPage");
            },
        },
    };
</script>

<template>
    <div id="loginPage" class="routerRealPage">
        <h1 class="loginPageRow" style="font-size: 2em">
            {{ mode === "login" ? $t("login.signin") : $t("login.signup") }}
        </h1>
        <div class="loginPageRow">
            {{ $t("login.username") }}：
            <input
                class="input textInput"
                style="width: calc(100% / 2)"
                v-model="username"
                autocomplete="username"
            />
        </div>
        <div class="loginPageRow">
            {{ $t("login.passwd") }}：
            <input
                class="input textInput"
                v-model="password"
                style="width: calc(100% / 2)"
                type="password"
                :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
                @keyup.enter="doSubmit"
            />
        </div>
        <div class="loginPageRow" v-if="mode === 'register'">
            {{ $t("login.confirmPasswd") }}：
            <input
                class="input textInput"
                v-model="confirmPassword"
                style="width: calc(100% / 2)"
                type="password"
                autocomplete="new-password"
                @keyup.enter="doSubmit"
            />
        </div>
        <div class="loginPageRow" v-if="mode === 'register'">
            {{ $t("login.nickname") }}：
            <input
                class="input textInput"
                v-model="nickname"
                style="width: calc(100% / 2)"
                :placeholder="$t('login.nicknamePlaceholder')"
            />
        </div>
        <div class="loginPageRow">
            <input
                type="button"
                style="width: auto; font-size: 1.5em"
                :value="mode === 'login' ? $t('login.signin') : $t('login.signup')"
                @click="doSubmit()"
            />
            <input
                type="button"
                style="width: auto; font-size: 1.5em"
                :value="mode === 'login' ? $t('login.toSignup') : $t('login.toSignin')"
                @click="switchMode()"
            />
        </div>
        <div class="loginPageRow">
            <input
                type="button"
                style="width: auto; font-size: 1.2em"
                :value="$t('login.playAsGuest')"
                @click="playAsGuest()"
            />
        </div>
        <div class="loginPageRow" style="font-size: 0.85em; opacity: 0.75">
            {{ $t("login.guestHint") }}
        </div>
    </div>
</template>

<style>
    #loginPage {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        align-content: center;
        margin-top: 50px;
    }

    .loginPageRow {
        width: 100%;
        margin: 10px;
        text-align: center;
    }

    .loginPageRow input:not([type="button"]) {
        width: 70%;
        height: 2em;
    }

    .loginPageRow input[type="button"] {
        font-size: 1.6em;
        width: 40%;
        margin: 6px;
    }
</style>
