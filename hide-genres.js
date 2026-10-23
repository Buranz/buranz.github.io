(function () {
    'use strict';

    // =====================================================================
    //  Скрыть жанры — плагин для Lampa
    //  Прячет с плиток (главный экран, подборки, категории) фильмы и
    //  сериалы выбранных жанров. Жанр считается по главному (первому)
    //  тегу TMDB. Мистика и детективы (в TMDB это один жанр 9648)
    //  разводятся по ключевым словам TMDB (supernatural, ghost, demon…).
    //
    //  Автор: Yury (github.com/Buranz)
    //  Лицензия: MIT
    //  Совместимость: ES5, Chromium 38 (webOS 3 / Tizen)
    // =====================================================================

    if (window.plugin_hide_genres_ready) return;
    window.plugin_hide_genres_ready = true;

    var VERSION = '1.1.1';
    var NAME = 'Скрыть жанры';
    var HIDDEN_CLASS = 'hide-genres--hidden';
    var MYSTERY_ID = 9648;

    // Жанры в настройках. main — id жанра TMDB, also — парный ТВ-жанр
    // (у сериалов своя сетка id). mystic/detective — виртуальные жанры
    // поверх 9648, разводятся ключевиками.
    var GENRES = [
        { key: '27',        main: 27,    also: [],      title: 'Ужасы', def: 'hide' },
        { key: 'mystic',                                title: 'Мистика' },
        { key: 'detective',                             title: 'Детективы' },
        { key: '53',        main: 53,    also: [],      title: 'Триллеры' },
        { key: '80',        main: 80,    also: [],      title: 'Криминал' },
        { key: '10752',     main: 10752, also: [10768], title: 'Военные' },
        { key: '99',        main: 99,    also: [],      title: 'Документальные' },
        { key: '16',        main: 16,    also: [],      title: 'Мультфильмы' },
        { key: '10749',     main: 10749, also: [],      title: 'Мелодрамы' }
    ];

    // Ключевики TMDB (английские, подстроки), по которым 9648 = мистика.
    // Нет совпадений — детектив.
    var MYSTIC_WORDS = [
        'supernatural', 'ghost', 'haunt', 'paranormal', 'occult',
        'demon', 'devil', 'satan', 'exorc', 'possess',
        'witch', 'vampire', 'zombie', 'undead', 'werewol',
        'poltergeist', 'spirit', 'curse', 'seance', 'afterlife',
        'psychic', 'mystic', 'monster'
    ];

    var blocked = {};          // {genre_id: true} — обычные жанры
    var hideMystic = false;
    var hideDetective = false;

    function log() {
        var args = ['[' + NAME + ']'];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        try { console.log.apply(console, args); } catch (e) {}
    }

    function settingKey(key) {
        return 'hide_genres_' + key;
    }

    // Селект «Показывать/Скрывать»; true/'true' — наследие тумблера v1.0.0
    function genreHidden(key, dflt) {
        var v = Lampa.Storage.get(key, dflt || 'show');
        return v === 'hide' || v === true || v === 'true';
    }

    function rebuildBlocked() {
        blocked = {};
        for (var i = 0; i < GENRES.length; i++) {
            var g = GENRES[i];
            if (g.main && genreHidden(settingKey(g.key), g.def)) {
                blocked[g.main] = true;
                for (var j = 0; j < g.also.length; j++) blocked[g.also[j]] = true;
            }
        }
        hideMystic = genreHidden(settingKey('mystic'));
        hideDetective = genreHidden(settingKey('detective'));
    }

    // ------------------------------------------------------------------
    //  Определение жанров карточки
    // ------------------------------------------------------------------

    function cardGenreIds(data) {
        var out = [];
        var src = data.genre_ids || data.genres;
        if (!src || !src.length) return out;

        for (var i = 0; i < src.length; i++) {
            var it = src[i];
            var n;
            if (typeof it === 'number') n = it;
            else if (it && typeof it === 'object') n = parseInt(it.id, 10);
            else n = parseInt(it, 10);
            if (!isNaN(n)) out.push(n);
        }
        return out;
    }

    function mediaType(data) {
        if (data.media_type === 'tv' || data.media_type === 'movie') return data.media_type;
        if (data.name || data.original_name || data.first_air_date) return 'tv';
        return 'movie';
    }

    // ------------------------------------------------------------------
    //  Мистика vs детектив: ключевики TMDB
    //  Кэш навсегда (мистичность фильма не меняется), очередь с
    //  дедупликацией, 4 параллельно, таймаут 8 с. Ошибки — на сессию,
    //  считаются детективом. Пока ответа нет — плитку не прячем.
    // ------------------------------------------------------------------

    var KW_CACHE_KEY = 'hide_genres_kw_v1';
    var KW_PARALLEL = 4;

    var kwCache = {};      // key -> 1 (мистика) / 0 (детектив), персистентно
    var kwSession = {};    // ошибки запросов — только на сессию
    var kwPending = {};    // key -> [карточки, ждущие ответа]
    var kwQueue = [];
    var kwActive = 0;
    var kwSaveTimer = null;
    var network = null;

    function loadKwCache() {
        kwCache = Lampa.Storage.get(KW_CACHE_KEY, {});
        if (!kwCache || typeof kwCache !== 'object') kwCache = {};
    }

    function saveKwCacheSoon() {
        if (kwSaveTimer) return;
        kwSaveTimer = setTimeout(function () {
            kwSaveTimer = null;
            try {
                if (Object.keys(kwCache).length > 5000) kwCache = {};
                Lampa.Storage.set(KW_CACHE_KEY, kwCache);
            } catch (e) {}
        }, 1000);
    }

    function net() {
        if (!network) {
            network = new Lampa.Reguest();
            network.timeout(8000);
        }
        return network;
    }

    function classifyKeywords(json) {
        var list = (json && (json.keywords || json.results)) || [];
        for (var i = 0; i < list.length; i++) {
            var name = ('' + (list[i] && list[i].name || '')).toLowerCase();
            for (var j = 0; j < MYSTIC_WORDS.length; j++) {
                if (name.indexOf(MYSTIC_WORDS[j]) >= 0) return 1;
            }
        }
        return 0;
    }

    function kwDone(task, val, persist) {
        if (persist) {
            kwCache[task.key] = val;
            saveKwCacheSoon();
        } else {
            kwSession[task.key] = val;
        }

        kwActive--;
        kwPump();

        var els = kwPending[task.key] || [];
        delete kwPending[task.key];
        for (var i = 0; i < els.length; i++) processCard(els[i]);
    }

    function kwFetch(task) {
        var url = Lampa.TMDB.api(task.type + '/' + task.id + '/keywords?api_key=' + Lampa.TMDB.key());

        net().silent(url, function (json) {
            kwDone(task, classifyKeywords(json), true);
        }, function () {
            kwDone(task, 0, false);
        });
    }

    function kwPump() {
        while (kwActive < KW_PARALLEL && kwQueue.length) {
            kwActive++;
            kwFetch(kwQueue.shift());
        }
    }

    // 1 — мистика, 0 — детектив, -1 — ещё не знаем (запрос в пути)
    function classifyMystery(data, el) {
        var id = data.id;
        if (!id) return 0;

        var type = mediaType(data);
        var key = (type === 'tv' ? 't' : 'm') + id;

        if (kwCache[key] !== undefined) return kwCache[key];
        if (kwSession[key] !== undefined) return kwSession[key];

        if (kwPending[key]) {
            if (el && kwPending[key].indexOf(el) < 0) kwPending[key].push(el);
        } else {
            kwPending[key] = el ? [el] : [];
            kwQueue.push({ key: key, type: type, id: id });
            kwPump();
        }
        return -1;
    }

    // ------------------------------------------------------------------
    //  Вердикт по карточке.
    //  Главный жанр = первый тег TMDB (проверено опытным путём
    //  в «CUB Лучшее»: порядок тегов отражает, что в фильме главное).
    // ------------------------------------------------------------------

    function shouldHide(data, el) {
        var ids = cardGenreIds(data);
        if (!ids.length) return false;

        var main = ids[0];

        if (main === MYSTERY_ID) {
            if (!hideMystic && !hideDetective) return false;
            if (hideMystic && hideDetective) return true;

            var cls = classifyMystery(data, el);
            if (cls === -1) return false;
            return cls === 1 ? hideMystic : hideDetective;
        }

        return !!blocked[main];
    }

    // ------------------------------------------------------------------
    //  В результатах поиска НЕ прячем никогда —
    //  иначе нельзя найти фильм, который ищешь намеренно.
    // ------------------------------------------------------------------

    function insideSearch(el) {
        var node = el;
        // Element.closest появился в Chromium 41 — руками
        while (node && node !== document.documentElement) {
            if (node.classList && (node.classList.contains('search-box') || node.classList.contains('search'))) return true;
            node = node.parentNode;
        }
        return false;
    }

    // ------------------------------------------------------------------
    //  Скрытие / возврат карточек.
    //  Грабли Lampa: элемент не удалять (Lampa пишет в него при каждом
    //  показе), фокусируемый элемент не прятать. Поэтому display:none
    //  через класс + снятие .selector, чтобы пульт карточку пропускал.
    // ------------------------------------------------------------------

    function hideCard(el) {
        if (el.classList.contains(HIDDEN_CLASS)) return;
        el.classList.add(HIDDEN_CLASS);
        if (el.classList.contains('selector')) {
            el.classList.remove('selector');
            el.__hg_selector = true;
        }
    }

    function showCard(el) {
        if (!el.classList.contains(HIDDEN_CLASS)) return;
        el.classList.remove(HIDDEN_CLASS);
        if (el.__hg_selector) {
            el.classList.add('selector');
            el.__hg_selector = false;
        }
    }

    function processCard(el) {
        var data = el.card_data;

        // card_data могли ещё не присвоить — одна отложенная повторная попытка
        if (!data) {
            if (!el.__hg_retry) {
                el.__hg_retry = true;
                setTimeout(function () { processCard(el); }, 300);
            }
            return;
        }

        if (shouldHide(data, el) && !insideSearch(el)) hideCard(el);
        else showCard(el);
    }

    function rescanAll() {
        rebuildBlocked();
        var cards = document.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) processCard(cards[i]);
    }

    // ------------------------------------------------------------------
    //  Наблюдатель за появлением карточек
    // ------------------------------------------------------------------

    function startObserver() {
        var observer = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var added = mutations[m].addedNodes;
                for (var i = 0; i < added.length; i++) {
                    var node = added[i];
                    if (node.nodeType !== 1) continue;
                    if (node.classList && node.classList.contains('card')) processCard(node);
                    else if (node.querySelectorAll) {
                        var cards = node.querySelectorAll('.card');
                        for (var k = 0; k < cards.length; k++) processCard(cards[k]);
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    function addStyle() {
        var style = document.createElement('style');
        style.textContent = '.' + HIDDEN_CLASS + '{display:none !important;}';
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------------
    //  Настройки
    //  Грабли: Lampa в настройках инвертирует иконку (filter:invert),
    //  поэтому штрих жёстко белый, не currentColor.
    // ------------------------------------------------------------------

    function icon() {
        return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M3 3 L21 21" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>' +
            '<path d="M6.6 6.8 C4.6 8.1 3 10 2 12 C4 16.5 7.8 19 12 19 C13.9 19 15.6 18.5 17.2 17.5 M10 4.2 C10.7 4.1 11.3 4 12 4 C16.2 4 20 6.5 22 12 C21.3 13.5 20.5 14.8 19.5 15.8" ' +
                'stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
            '<path d="M9.9 9.9 C9.3 10.5 9 11.2 9 12 C9 13.7 10.3 15 12 15 C12.8 15 13.5 14.7 14.1 14.1" ' +
                'stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none"/>' +
            '</svg>';
    }

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'hide_genres',
            name: NAME,
            icon: icon()
        });

        for (var i = 0; i < GENRES.length; i++) {
            (function (g) {
                Lampa.SettingsApi.addParam({
                    component: 'hide_genres',
                    param: {
                        name: settingKey(g.key),
                        type: 'select',
                        values: {
                            show: 'Показывать',
                            hide: 'Скрывать'
                        },
                        'default': g.def || 'show'
                    },
                    field: {
                        name: g.title
                    },
                    onChange: function () {
                        setTimeout(rescanAll, 50);
                    }
                });
            })(GENRES[i]);
        }
    }

    // Миграция с версий до 1.1.0: общий пункт «Мистика и детективы»
    // (ключ 9648) раскладывается на оба новых.
    function migrate() {
        try {
            var old = Lampa.Storage.get(settingKey('9648'), 'none');
            if (old === 'hide' || old === true || old === 'true') {
                if (Lampa.Storage.get(settingKey('mystic'), 'none') === 'none') Lampa.Storage.set(settingKey('mystic'), 'hide');
                if (Lampa.Storage.get(settingKey('detective'), 'none') === 'none') Lampa.Storage.set(settingKey('detective'), 'hide');
                Lampa.Storage.set(settingKey('9648'), 'show');
            }
        } catch (e) {}
    }

    // Lampa при ручном добавлении по URL не знает имени плагина —
    // вписываем себя в Storage('plugins') сами.
    function registerName() {
        try {
            var plugins = Lampa.Storage.get('plugins', []);
            var changed = false;
            for (var i = 0; i < plugins.length; i++) {
                var url = plugins[i].url || '';
                if (url.indexOf('hide-genres.js') >= 0 && plugins[i].name !== NAME) {
                    plugins[i].name = NAME;
                    changed = true;
                }
            }
            if (changed) Lampa.Storage.set('plugins', plugins);
        } catch (e) {}
    }

    // ------------------------------------------------------------------
    //  Старт
    // ------------------------------------------------------------------

    function start() {
        migrate();
        loadKwCache();
        rebuildBlocked();
        addStyle();
        addSettings();
        registerName();
        startObserver();
        rescanAll();

        // Ловим смену настроек, в том числе из других мест
        Lampa.Storage.listener.follow('change', function (e) {
            if (e.name && e.name.indexOf('hide_genres_') === 0) rescanAll();
        });

        log('v' + VERSION + ' запущен');
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
