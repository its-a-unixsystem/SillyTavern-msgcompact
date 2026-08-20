import { getStringHash } from '../../../utils.js';

const MODULE = 'msgcompact';
const MODULE_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const TOAST_TITLE = 'Message Compact';
const MIN_TOKENS = 30;

const DEFAULT_PROMPT = `Rewrite the following roleplay message so it uses far fewer tokens it only has to be understood by another AI, not a human.
Keep, in their original order: all dialogue (tighten wording only where meaning and tone survive), every plot-relevant action, and all names, facts, and numbers exactly.
Remove: scenery, atmosphere, body language, sensory detail, and internal monologue, unless plot-relevant. When a sentence mixes an action with description, keep the bare action and drop the descriptive modifiers.
Use short, plain sentences, ASD-STE100 Simplified Technical English. Style may suffer; information may not. Keep the original language of the message.


Output only the rewritten message, nothing else.

Message:
{{message}}`;

const default_settings = {
    prompt: DEFAULT_PROMPT,
    connection_profile: '',
    response_length: 0,
    show_tokens: true,
    gray_original: true,
};

const BUTTON_HTML = '<div title="Compact message" class="mes_button mc_button fa-solid fa-down-left-and-up-right-to-center" tabindex="0"></div>';

// messages with a compaction request in flight (keyed by object, indexes can shift)
const running = new Set();

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const allSettings = getContext().extensionSettings;
    if (!allSettings[MODULE]) {
        allSettings[MODULE] = structuredClone(default_settings);
    }
    for (const key of Object.keys(default_settings)) {
        if (!(key in allSettings[MODULE])) {
            allSettings[MODULE][key] = default_settings[key];
        }
    }
    return allSettings[MODULE];
}

function getConnectionProfiles() {
    return getContext().extensionSettings?.connectionManager?.profiles ?? [];
}

function stateOf(message) {
    if (running.has(message)) return 'running';
    const mc = message?.extra?.msgcompact;
    if (!mc) return 'none';
    if (mc.hash !== getStringHash(message.mes)) return 'stale';
    return mc.active ? 'active' : 'inactive';
}

globalThis.msgcompact_interceptor = async function (chat, _contextSize, _abort, type) {
    if (type === 'quiet') return;
    const replacements = new Map();
    for (const message of getContext().chat) {
        const mc = message.extra?.msgcompact;
        if (mc?.active && mc.hash === getStringHash(message.mes)) {
            replacements.set(message.extra, mc.text);
        }
    }
    if (!replacements.size) return;
    // on continue, the model must resume from the exact text ST will append to
    const end = type === 'continue' ? chat.length - 1 : chat.length;
    for (let i = 0; i < end; i++) {
        const text = chat[i].extra && replacements.get(chat[i].extra);
        if (text) chat[i].mes = text;
    }
};

async function compactMessage(mesId) {
    const ctx = getContext();
    const message = ctx.chat[mesId];
    if (!message || message.is_system || running.has(message)) return;
    if (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished) {
        toastr.warning('Wait for the current generation to finish.', TOAST_TITLE);
        return;
    }

    const settings = getSettings();
    const tokensBefore = await ctx.getTokenCountAsync(message.mes);
    if (tokensBefore < MIN_TOKENS) {
        toastr.info(`Message is only ${tokensBefore} tokens — nothing to gain.`, TOAST_TITLE);
        return;
    }

    running.add(message);
    renderMessage(mesId);

    try {
        const prompt = ctx.substituteParamsExtended(settings.prompt, { message: message.mes });
        // no size-derived cap: thinking models spend output tokens on reasoning,
        // so a tight maxOutputTokens truncates the response before any content
        const maxLength = settings.response_length > 0 ? settings.response_length : 0;
        const profileId = settings.connection_profile;
        const useProfile = profileId && getConnectionProfiles().some(p => p.id === profileId);
        console.log(`[${MODULE}] compacting message ${mesId} (${tokensBefore} tokens) via ${useProfile ? `profile "${getConnectionProfiles().find(p => p.id === profileId)?.name}"` : `current API (${ctx.mainApi})`}, max response ${maxLength || 'default'} tokens`);
        console.log(`[${MODULE}] prompt:\n${prompt}`);
        let result;
        if (useProfile) {
            const data = await ctx.ConnectionManagerRequestService.sendRequest(profileId, prompt, maxLength || Math.max(2048, tokensBefore * 2));
            console.log(`[${MODULE}] raw response:`, data);
            result = typeof data === 'string' ? data : data?.content;
        } else {
            result = await ctx.generateRaw({ prompt, responseLength: maxLength || null });
            console.log(`[${MODULE}] raw response:`, result);
        }

        result = String(result ?? '').trim();
        if (!result) {
            toastr.error('The model returned an empty result.', TOAST_TITLE);
            return;
        }

        const tokensAfter = await ctx.getTokenCountAsync(result);
        if (tokensAfter >= tokensBefore) {
            toastr.warning(`Result is not smaller (${tokensBefore} → ${tokensAfter} tokens). Stored anyway — check your prompt.`, TOAST_TITLE);
        }

        message.extra = message.extra ?? {};
        message.extra.msgcompact = {
            text: result,
            active: true,
            hash: getStringHash(message.mes),
            tokens_before: tokensBefore,
            tokens_after: tokensAfter,
            created: Date.now(),
        };
        await ctx.saveChat();
    } catch (error) {
        console.error(`[${MODULE}]`, error);
        toastr.error(error?.message || 'Generation failed.', TOAST_TITLE);
    } finally {
        running.delete(message);
        renderMessage(getContext().chat.indexOf(message));
    }
}

async function toggleCompaction(mesId) {
    const ctx = getContext();
    const mc = ctx.chat[mesId]?.extra?.msgcompact;
    if (!mc) return;
    mc.active = !mc.active;
    await ctx.saveChat();
    renderMessage(mesId);
}

async function deleteCompaction(mesId) {
    const ctx = getContext();
    const message = ctx.chat[mesId];
    if (!message?.extra?.msgcompact) return;
    delete message.extra.msgcompact;
    await ctx.saveChat();
    renderMessage(mesId);
}

async function saveEditedCompaction(mesId, text) {
    const ctx = getContext();
    const mc = ctx.chat[mesId]?.extra?.msgcompact;
    if (!mc) return;
    text = text.trim();
    if (text && text !== mc.text) {
        mc.text = text;
        mc.tokens_after = await ctx.getTokenCountAsync(text);
        await ctx.saveChat();
    }
    renderMessage(mesId);
}

function buildBlock(mesId, mc, state, settings) {
    const $block = $(`
        <div class="mc_block">
            <div class="mc_header">
                <span class="mc_label">compacted</span>
                <span class="mc_tokens"></span>
                <span class="mc_stale_note">original edited — not sent to the model</span>
                <div class="mc_controls">
                    <i class="mc_rerun fa-solid fa-rotate" title="Re-run compaction"></i>
                    <i class="mc_edit fa-solid fa-pencil" title="Edit compaction"></i>
                    <i class="mc_delete fa-solid fa-trash-can" title="Delete compaction"></i>
                </div>
            </div>
            <div class="mc_text"></div>
        </div>`);
    $block.toggleClass('mc_inactive', state === 'inactive');
    $block.toggleClass('mc_stale', state === 'stale');
    $block.find('.mc_text').text(mc.text);
    if (settings.show_tokens && mc.tokens_before && mc.tokens_after) {
        const percent = Math.round((1 - mc.tokens_after / mc.tokens_before) * 100);
        $block.find('.mc_tokens').text(`${mc.tokens_before} → ${mc.tokens_after} tokens (${percent >= 0 ? '−' : '+'}${Math.abs(percent)}%)`);
    }
    return $block;
}

function renderMessage(mesId) {
    if (mesId === undefined || mesId === null || mesId < 0) return;
    const $mes = $(`#chat .mes[mesid="${mesId}"]`);
    if (!$mes.length) return;
    const message = getContext().chat[mesId];
    if (!message) return;

    $mes.find('.mc_block').remove();

    if (message.is_system) {
        $mes.find('.mc_button').remove();
        $mes.find('.mes_text').removeClass('mc_grayed');
        return;
    }

    let $button = $mes.find('.mc_button');
    if (!$button.length) {
        $button = $(BUTTON_HTML).prependTo($mes.find('.mes_buttons'));
    }

    const settings = getSettings();
    const state = stateOf(message);
    const mc = message.extra?.msgcompact;

    $button
        .toggleClass('fa-down-left-and-up-right-to-center', state !== 'running')
        .toggleClass('fa-spinner fa-spin', state === 'running')
        .removeClass('mc_state_active mc_state_inactive mc_state_stale');
    const titles = {
        none: 'Compact message',
        running: 'Compacting…',
        active: 'Compaction active — click to use the original',
        inactive: 'Compaction inactive — click to use the compaction',
        stale: 'Original was edited — click to re-run compaction',
    };
    $button.attr('title', titles[state]);
    if (state === 'active' || state === 'inactive' || state === 'stale') {
        $button.addClass(`mc_state_${state}`);
    }

    $mes.find('.mes_text').toggleClass('mc_grayed', state === 'active' && settings.gray_original);

    if (mc && state !== 'running') {
        buildBlock(mesId, mc, state, settings).insertAfter($mes.find('.mes_text'));
    }
}

function renderAll() {
    $('#chat .mes').each(function () {
        renderMessage(Number($(this).attr('mesid')));
    });
}

function startEdit($block, mesId) {
    const mc = getContext().chat[mesId]?.extra?.msgcompact;
    if (!mc || $block.find('.mc_edit_textarea').length) return;
    const $text = $block.find('.mc_text');
    const $textarea = $('<textarea class="mc_edit_textarea text_pole"></textarea>').val(mc.text);
    $text.replaceWith($textarea);
    $textarea.trigger('focus');
    $textarea.on('keydown', function (event) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $(this).trigger('blur');
        if (event.key === 'Escape') renderMessage(mesId);
    });
    $textarea.on('blur', function () {
        saveEditedCompaction(mesId, String($(this).val()));
    });
}

function mesIdOf(element) {
    return Number($(element).closest('.mes').attr('mesid'));
}

function bindChatHandlers() {
    $(document).on('click', '.mc_button', function () {
        const mesId = mesIdOf(this);
        const state = stateOf(getContext().chat[mesId]);
        if (state === 'none' || state === 'stale') compactMessage(mesId);
        else if (state === 'active' || state === 'inactive') toggleCompaction(mesId);
    });
    $(document).on('click', '.mc_rerun', function () {
        compactMessage(mesIdOf(this));
    });
    $(document).on('click', '.mc_delete', function () {
        deleteCompaction(mesIdOf(this));
    });
    $(document).on('click', '.mc_edit', function () {
        startEdit($(this).closest('.mc_block'), mesIdOf(this));
    });
}

function refreshProfileOptions() {
    const $select = $('#mc_profile');
    const profiles = getConnectionProfiles();
    const current = getSettings().connection_profile;
    $select.empty().append($('<option value="">Current connection</option>'));
    if (!profiles.length) {
        $select.append($('<option value="" disabled>— no connection profiles defined —</option>'));
    }
    for (const profile of profiles) {
        $select.append($('<option></option>').val(profile.id).text(profile.name ?? profile.id));
    }
    $select.val(profiles.some(p => p.id === current) ? current : '');
}

async function loadSettingsUi() {
    const response = await fetch(`${MODULE_DIR}/settings.html`);
    $('#extensions_settings2').append(await response.text());

    const settings = getSettings();
    const save = () => getContext().saveSettingsDebounced();

    $('#mc_prompt').val(settings.prompt).on('input', function () {
        getSettings().prompt = String($(this).val());
        save();
    });
    $('#mc_prompt_restore').on('click', function () {
        getSettings().prompt = DEFAULT_PROMPT;
        $('#mc_prompt').val(DEFAULT_PROMPT);
        save();
    });
    $('#mc_profile').on('change', function () {
        getSettings().connection_profile = String($(this).val());
        save();
    });
    // repopulate when the drawer opens, not on select focus: rebuilding options
    // while the browser opens the dropdown makes it close with nothing selectable
    $('#msgcompact_settings .inline-drawer-toggle').on('click', refreshProfileOptions);
    $('#mc_response_length').val(settings.response_length).on('input', function () {
        getSettings().response_length = Math.max(0, Number($(this).val()) || 0);
        save();
    });
    $('#mc_show_tokens').prop('checked', settings.show_tokens).on('change', function () {
        getSettings().show_tokens = $(this).prop('checked');
        save();
        renderAll();
    });
    $('#mc_gray_original').prop('checked', settings.gray_original).on('change', function () {
        getSettings().gray_original = $(this).prop('checked');
        save();
        renderAll();
    });
    refreshProfileOptions();
}

jQuery(async () => {
    const { eventSource, event_types } = getContext();

    await loadSettingsUi();
    $('#message_template .mes_buttons').prepend(BUTTON_HTML);
    bindChatHandlers();

    eventSource.on(event_types.CHAT_CHANGED, renderAll);
    eventSource.on(event_types.MESSAGE_DELETED, renderAll);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, renderMessage);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, renderMessage);
    eventSource.on(event_types.MESSAGE_EDITED, renderMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, renderMessage);

    renderAll();
});
