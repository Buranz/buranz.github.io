/**
 * CUB Rating — плагин для Lampa
 *
 * Показывает рейтинг CUB (рассчитанный из реакций пользователей)
 * на плитках в гридах вместо рейтинга TMDB, а также добавляет
 * бейдж "CUB" на экран деталей фильма/сериала.
 *
 * TMDB на плитки никогда не подставляется: если рейтинга CUB нет
 * (нет реакций / меньше порога / CUB недоступен) — плитка без цифры.
 *
 * Плюс раздел меню "CUB Лучшее": каталог фильмов/сериалов по жанрам,
 * отсортированный по рейтингу CUB (кандидаты берутся с TMDB по
 * популярности, рейтинг считается на лету из реакций).
 *
 * Рейтинг считается как взвешенное среднее реакций:
 *   fire=5, nice=4, think=3, bore=2, shit=1  ->  (sum/total)*2  => шкала 2..10
 *
 * Установка: Настройки -> Расширения -> Добавить плагин -> URL этого файла.
 * Код написан на ES5 для совместимости со старыми TV-браузерами (webOS/Tizen).
 */

(function () {
    'use strict';

    if (window.plugin_cub_best_ready) return;
    window.plugin_cub_best_ready = true;

    var PLUGIN  = 'cub_best';
    var VERSION = '1.0.4';

    // домен CUB из манифеста Lampa; фолбэк — на случай экзотических сборок
    function cubDomain() {
        return (Lampa.Manifest && Lampa.Manifest.cub_domain) || 'cub.red';
    }

    // Одна форма звезды на всё: пункт меню и раздел настроек.
    // Цвет разный не случайно: в настройках Lampa при фокусе красит элемент
    // в color:#000 И инвертирует иконку (filter:invert) — currentColor там
    // инвертируется дважды и пропадает, поэтому для настроек штрих жёстко белый.
    function starIcon(color) {
        return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8L12 2z" fill="' + color + '" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    }

    var ICON_STAR = starIcon('currentColor');

    // ---------- настройки по умолчанию ----------

    var DEFAULTS = {
        cub_best_cards: true,   // рейтинг CUB на плитках
        cub_best_full: true,    // бейдж CUB на экране деталей
        cub_best_min_votes: 50, // минимум реакций для показа рейтинга (плитки и карточка)
        cub_best_batch: 25,     // глубина поиска: страниц TMDB (по 20 тайтлов) на страницу раздела
        cub_best_preset: 'master', // режим отбора каталога (см. PRESETS)
        cub_best_first_genre: false // показывать только тайтлы, где выбранный жанр стоит первым
    };

    function pref(name) {
        var v = Lampa.Storage.get(name, DEFAULTS[name]);
        if (v === 'true') return true;
        if (v === 'false') return false;
        return v;
    }

    // ---------- расчёт рейтинга из реакций ----------

    // Веса реакций и байесовское сглаживание — как у плагина RootU
    // (plugin.rootu.top/cub-rating.js), чтобы цифры совпадали с ним.
    // Пока голосов мало, рейтинг прижат к средней оценке по базе CUB
    // и "отпускается" к реальному по мере набора реакций (приём IMDb Top 250).
    var WEIGHTS = { fire: 10, nice: 7.5, think: 5, bore: 2.5, shit: 0 };

    var PRIOR = {
        movie: { avg: 6.584, m: 274 },
        tv:    { avg: 7.436, m: 69 }
    };

    // Цветовая индикация по величине рейтинга:
    // ниже 6 — красный, 6–7 — жёлтый, 7–8 — синий, от 8 — зелёный.
    // Малонадёжные рейтинги не красятся в "неуверенный" цвет, а просто
    // не показываются (порог — настройка "Минимум реакций")
    var COLOR_LOW  = '#ff6b61';
    var COLOR_MID  = '#ffd166';
    var COLOR_GOOD = '#6ec6ff';
    var COLOR_HIGH = '#9cfc87';

    function ratingColor(rating) {
        if (rating < 6) return COLOR_LOW;
        if (rating < 7) return COLOR_MID;
        if (rating < 8) return COLOR_GOOD;
        return COLOR_HIGH;
    }

    /**
     * @param {Array} result - массив [{type:'fire', counter: 123}, ...]
     * @param {boolean} isTv - сериал или фильм (у них разные априорные средние)
     * @returns {{rating:number, total:number}|null}
     */
    function calcRating(result, isTv) {
        var sum = 0, total = 0, counts = {};

        (result || []).forEach(function (r) {
            // hasOwnProperty, а не if(w): вес shit = 0, но голос считается
            if (WEIGHTS.hasOwnProperty(r.type) && r.counter) {
                sum   += WEIGHTS[r.type] * r.counter;
                total += r.counter;
                counts[r.type] = r.counter;
            }
        });

        if (!total) return null;

        // Медианная эмоция (как у RootU) — реакция "срединного" голосующего:
        // идём от лучшей реакции к худшей, пока не накопим половину голосов.
        // Честнее самой массовой: согласуется с рейтингом на спорных тайтлах
        var order = ['fire', 'nice', 'think', 'bore', 'shit'];
        var median = null, cum = 0, half = Math.floor(total / 2);

        for (var i = 0; i < order.length; i++) {
            if (counts[order[i]]) {
                median = order[i];
                cum += counts[order[i]];

                if (cum >= half) break;
            }
        }

        var p = isTv ? PRIOR.tv : PRIOR.movie;
        var rating = Math.round((p.avg * p.m + sum) / (p.m + total) * 10) / 10;
        if (rating > 10) rating = 10;

        // Доля восторгов (🔥+👍) в процентах — мера консенсуса: меньше
        // 60% значит сообщество раскололось (пресет "Неоднозначно")
        var positive = Math.round((((counts.fire || 0) + (counts.nice || 0)) / total) * 100);

        return { rating: rating, total: total, median: median, positive: positive };
    }

    // известные типы реакций (значения-эмодзи остаются как справочник);
    // в бейдже рисуется фирменная SVG-иконка Lampa этого типа
    var EMOJI = { fire: '🔥', nice: '👍', think: '🤔', bore: '😴', shit: '💩' };

    // ---------- кэш (память + localStorage, TTL 24ч) ----------

    // v2: при смене формулы меняем ключ, чтобы не мешать старые значения с новыми
    var CACHE_KEY  = 'cub_rating_cache_v3';
    var CACHE_MAX  = 5000;             // максимум записей в localStorage
    var TTL_OK     = 24 * 60 * 60 * 1000;
    var TTL_FAIL   = 60 * 60 * 1000;   // ошибки сети не долбим повторно час

    var persisted = Lampa.Storage.cache(CACHE_KEY, CACHE_MAX, {});
    var save_timer = null;

    function cacheGet(key) {
        var item = persisted[key];
        if (!item) return null;

        var ttl = item.f ? TTL_FAIL : TTL_OK;
        if (Date.now() - item.t > ttl) return null;

        return item;
    }

    function cacheSet(key, data) {
        data.t = Date.now();
        persisted[key] = data;

        // пишем в localStorage отложенно одним куском, а не на каждый ответ
        if (save_timer) clearTimeout(save_timer);

        save_timer = setTimeout(function () {
            save_timer = null;
            Lampa.Storage.set(CACHE_KEY, persisted);
        }, 1000);
    }

    // ---------- загрузка реакций с CUB (очередь, 4 параллельно) ----------

    var network  = new Lampa.Reguest();
    var waiting  = {};   // key -> [callback, ...] (дедупликация запросов)
    var queue    = [];
    var running  = 0;
    var PARALLEL = 10;

    function apiUrl(key) {
        return Lampa.Utils.protocol() + cubDomain() + '/api/reactions/get/' + key;
    }

    function next() {
        if (running >= PARALLEL || !queue.length) return;

        var key = queue.shift();
        running++;

        network.timeout(8000);
        network.silent(apiUrl(key), function (json) {
            var data = { f: 1 };
            var calc = json && json.result ? calcRating(json.result, key.indexOf('tv_') === 0) : null;

            if (calc) data = { r: calc.rating, n: calc.total, d: calc.median, p: calc.positive };

            done(key, data);
        }, function () {
            done(key, { f: 1 });
        });
    }

    function done(key, data) {
        running--;
        cacheSet(key, data);

        (waiting[key] || []).forEach(function (cb) { cb(data); });
        delete waiting[key];

        next();
    }

    /**
     * Получить рейтинг: из кэша или с сервера.
     * @param {string} key - 'movie_123' | 'tv_456'
     * @param {Function} callback - вызывается с {r, n} или {f:1}
     */
    function getRating(key, callback) {
        var cached = cacheGet(key);
        if (cached) return callback(cached);

        if (waiting[key]) return waiting[key].push(callback);

        waiting[key] = [callback];
        queue.push(key);
        next();
    }

    // ---------- ключ карточки ----------

    function cardKey(data) {
        if (!data || !data.id) return null;
        if (data.cub_more) return null; // псевдо-тайтл "Загрузить ещё"

        // только фильмы/сериалы с TMDB id
        if (data.media_type && data.media_type !== 'movie' && data.media_type !== 'tv') return null;
        if (data.source && data.source !== 'tmdb' && data.source !== 'cub') return null;

        var tv = data.media_type === 'tv' || !!data.name || !!data.first_air_date;

        return (tv ? 'tv_' : 'movie_') + data.id;
    }

    // ---------- плитки в гридах ----------

    function processCard(el) {
        if (el.getAttribute('data-cub-rating')) return;
        el.setAttribute('data-cub-rating', '1');

        var data = el.card_data;
        if (!data) return;

        var key = cardKey(data);
        if (!key) return;

        getRating(key, function (res) {
            if (!document.body.contains(el)) return;

            var vote = el.querySelector('.card__vote');
            var show = res.r && res.n >= pref('cub_best_min_votes');

            // рейтинга CUB нет (мало реакций / ошибка) — плитка без цифры
            if (!show) {
                if (vote) vote.remove();
                return;
            }

            if (!vote) {
                var view = el.querySelector('.card__view');
                if (!view) return;

                vote = document.createElement('div');
                vote.classList.add('card__vote');
                view.appendChild(vote);
            }

            vote.innerText = res.r.toFixed(1).replace('10.0', '10');
            vote.classList.add('card__vote--cub');
            vote.style.setProperty('color', ratingColor(res.r), 'important');
        });
    }

    // Загружаем рейтинг только когда плитка близка к экрану (если браузер умеет)
    var intersection = null;

    if (typeof IntersectionObserver !== 'undefined') {
        intersection = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    intersection.unobserve(entry.target);
                    processCard(entry.target);
                }
            });
        }, { rootMargin: '300px' });
    }

    // Сразу убираем цифру TMDB: до загрузки CUB плитка остаётся без
    // рейтинга, чтобы TMDB нельзя было принять за CUB
    function stripTmdbVote(el) {
        var data = el.card_data;
        if (!data) return;
        if (!cardKey(data)) return;

        var vote = el.querySelector('.card__vote');
        if (vote && !vote.classList.contains('card__vote--cub')) vote.remove();
    }

    function watchCard(el) {
        // броня: странный скин или вёрстка не должны уронить Lampa
        try {
            if (el.card_data && el.card_data.cub_more) return decorateMoreCard(el);

            stripTmdbVote(el);

            if (intersection) intersection.observe(el);
            else processCard(el);
        }
        catch (e) {
            console.log('CUB Лучшее', 'ошибка обработки карточки:', e && e.message);
        }
    }

    function scan(root) {
        if (root.classList && root.classList.contains('card')) watchCard(root);

        if (root.querySelectorAll) {
            var cards = root.querySelectorAll('.card');
            for (var i = 0; i < cards.length; i++) watchCard(cards[i]);
        }
    }

    var observer = null;

    // closest('.card') вручную — на старых ТВ-браузерах closest() нет
    function parentCard(el) {
        while (el && el !== document.body) {
            if (el.classList && el.classList.contains('card')) return el;
            el = el.parentNode;
        }

        return null;
    }

    function startCards() {
        scan(document.body);

        observer = new MutationObserver(function (mutations) {
            if (!pref('cub_best_cards')) return;

            mutations.forEach(function (m) {
                for (var i = 0; i < m.addedNodes.length; i++) {
                    var node = m.addedNodes[i];

                    if (node.nodeType !== 1) continue;

                    // Lampa может пересоздать цифру на уже обработанной
                    // плитке (обновление карточки) — тогда наша раскраска
                    // слетает на цвет скина; перекрашиваем заново
                    if (node.classList && node.classList.contains('card__vote') && !node.classList.contains('card__vote--cub')) {
                        var card = parentCard(node);

                        if (card) {
                            card.removeAttribute('data-cub-rating');
                            watchCard(card);
                        }

                        continue;
                    }

                    scan(node);
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ---------- экран деталей (бейдж CUB рядом с TMDB) ----------

    function startFull() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite' || !pref('cub_best_full')) return;

            var render = e.object.activity.render();

            var movie = e.data.movie;
            if (!movie) return;

            var key = cardKey(movie);
            if (!key) return;
            var line = render.find('.full-start-new__rate-line, .full-start__rate-line');

            if (!line.length || line.find('.rate--cub').length) return;

            function draw(res) {
                if (!res.r || res.n < pref('cub_best_min_votes')) return;
                if (line.find('.rate--cub').length) return;

                var emoji = '';
                var color = ratingColor(res.r);

                // та же иконка, что у реакций Lampa ниже — SVG с сервера CUB
                if (res.d && EMOJI[res.d]) {
                    emoji = '<img src="' + Lampa.Utils.protocol() + cubDomain() + '/img/reactions/' + res.d + '.svg" style="height:1.1em;vertical-align:-0.18em;margin-right:0.3em" onerror="this.style.display=\'none\'"> ';
                }

                var badge = $('<div class="full-start__rate rate--cub"><div>' + res.r.toFixed(1).replace('10.0', '10') + '</div><div class="source--name">' + emoji + 'CUB</div></div>');

                // цифра и слово CUB — одним цветом светофора
                badge.find('div').eq(0)[0].style.setProperty('color', color, 'important');
                badge.find('.source--name')[0].style.setProperty('color', color, 'important');

                var tmdb = line.find('.rate--tmdb');
                if (tmdb.length) tmdb.after(badge);
                else line.prepend(badge);
            }

            // Lampa уже загрузила реакции для блока под описанием — берём их:
            // ноль лишних запросов, свежие данные, и заодно прогреваем кэш
            // рейтингов для плиток
            var live = e.data.reactions && e.data.reactions.result;

            if (live) {
                var calc = calcRating(live, key.indexOf('tv_') === 0);
                var data = calc ? { r: calc.rating, n: calc.total, d: calc.median, p: calc.positive } : { f: 1 };

                cacheSet(key, data);
                draw(data);
            }
            else {
                getRating(key, draw);
            }
        });
    }

    // ---------- CUB Лучшее: каталог с сортировкой по рейтингу CUB ----------
    //
    // Свой источник данных для штатного компонента category_full:
    // берём пачку популярных тайтлов с TMDB (3 страницы discover на одну
    // страницу каталога), считаем каждому рейтинг CUB и сортируем по нему.
    // Тайтлы без рейтинга уходят в конец списка.

    var FILTER_SOURCE = 'cub_best';
    var FILTER_SOURCE_LEGACY = 'cub_filter'; // активности, сохранённые до переименования
    // Пресеты отбора каталога — три характера выдачи вместо россыпи порогов:
    //   master — фестивальный отбор: только проверенное величие;
    //   solid  — "качественно, но не удивил": крепкое кино БЕЗ шедевров
    //            (диапазон, а не порог — шедевры живут в master);
    //   weird  — самое странное: фильмы, над которыми сообщество
    //            задумалось (медианная реакция 🤔)
    // Порог консенсуса для "Неоднозначно": восторгов (🔥+👍) меньше этой
    // доли процентов — мнения разделились
    var WEIRD_POSITIVE_MAX = 60;

    var PRESETS = {
        master: { min_rating: 8.0, max_rating: 11,  min_votes: 100, median: null },
        solid:  { min_rating: 7.0, max_rating: 11,  min_votes: 50,  median: null },
        weird:  { min_rating: 6.0, max_rating: 11,  min_votes: 20,  median: 'think' }
    };

    function presetConfig() {
        return PRESETS[pref('cub_best_preset')] || PRESETS.master;
    }

    // Если страница после всех фильтров дала меньше этого — жанр почти
    // вычерпан: плитку "Загрузить ещё" не показываем. Порог небольшой,
    // потому что узкие пресеты (Неоднозначно) дают скромные страницы
    var CATALOG_PAGE_YIELD = 30;

    // Готовые страницы каталога держим в памяти: возврат из карточки
    // пересоздаёт активность, и без этого кэша поиск запускался бы заново
    var list_cache = {};
    var LIST_CACHE_TIME = 60 * 60 * 1000; // час: дольше любого фильма между возвратами

    // Отложенный поиск следующей страницы: Lampa ждёт ответ на свой
    // упреждающий запрос и не повторяет его — ответ отпускается плиткой
    // "Загрузить ещё"
    var pending_more = null;

    // Плитка "Загрузить ещё" приходит в данных как псевдо-тайтл: Lampa сама
    // строит для него полноценную карточку (фокус, скролл и место в сетке —
    // штатные), а здесь она получает фирменный вид и перехват нажатия
    // Одноразовый CSS плитки "Загрузить ещё": градиент как у прогресс-бара,
    // прячем ленивый постер и чужие бейджи, чтобы не перекрывали заливку
    function ensureMoreCss() {
        if (document.getElementById('cub-more-style')) return;

        var st = document.createElement('style');

        st.id = 'cub-more-style';
        st.textContent =
            '[data-cub-more] .card__view{background:linear-gradient(135deg,#4ade80,#9cfc87) !important;overflow:hidden !important}' +
            '[data-cub-more] img{display:none !important}' +
            '[data-cub-more] .card__type,[data-cub-more] .card__vote,[data-cub-more] .card__quality,[data-cub-more] .card__icons,[data-cub-more] .card__marker{display:none !important}' +
            '[data-cub-more].focus .card__view,[data-cub-more].hover .card__view{box-shadow:0 0 0 0.22em rgba(0,0,0,0.85), 0 0 0 0.5em #fff !important}';

        document.head.appendChild(st);
    }

    function decorateMoreCard(el) {
        if (el.getAttribute('data-cub-more')) return;
        el.setAttribute('data-cub-more', '1');

        ensureMoreCss();

        var view = el.querySelector('.card__view');

        if (view) {
            // скругление — как у живых соседних карточек этого скина
            var radius = '1em';
            var sample = document.querySelector('.card:not([data-cub-more]) .card__view, .card:not([data-cub-more]) .card__img');

            if (sample) {
                var r = getComputedStyle(sample).borderRadius;
                if (r && r !== '0px') radius = r;
            }

            view.style.setProperty('border-radius', radius, 'important');

            // Начинку карточки НЕ сносим (Lampa пишет в card__icons-inner при
            // каждом показе — её отсутствие роняет приложение), а накрываем
            // своим слоем; оригиналы спрятаны через CSS
            view.insertAdjacentHTML('beforeend',
                '<div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;z-index:2">' +
                '<div style="font-size:4em;font-weight:700;color:#000;line-height:1">+</div>' +
                '</div>');
        }

        hookMoreEnter();
    }

    // Нажатие на псевдо-плитку перехватываем на фазе погружения: Lampa
    // рассылает enter НАТИВНЫМ DOM-событием, и штатный обработчик карточки
    // (addEventListener) открыл бы full несуществующего фильма с вечным
    // стробберем. Capture на документе срабатывает раньше и глушит его
    var more_enter_hooked = false;

    function hookMoreEnter() {
        if (more_enter_hooked) return;
        more_enter_hooked = true;

        document.addEventListener('hover:enter', function (e) {
            var el = e.target;

            if (!el || !el.getAttribute || !el.getAttribute('data-cub-more')) return;

            e.stopImmediatePropagation();
            e.stopPropagation();

            var p = pending_more;

            // упреждающий запрос ещё не пришёл — просто игнорируем нажатие
            if (!p) return;

            pending_more = null;
            el.style.display = 'none';

            p.run();
        }, true);
    }

    // На какой странице жанр вычерпался (ключ без номера страницы).
    // Lampa не обновляет total_pages на догрузках и после пустого ответа
    // продолжает запрашивать всё более глубокие страницы — поэтому всё,
    // что глубже этой отметки, отвечаем мгновенно и пусто сами
    var exhausted_cache = {};

    // Размер порции настраивается (cub_best_batch, страниц TMDB по 20
    // тайтлов): большая порция = сортировка одним куском без "пилы",
    // но на слабых ТВ рендер 500 плиток может тормозить.

    // Моно-линейные SVG-иконки жанров: системные эмодзи на платформах
    // выглядят по-разному, свои иконки — одинаково везде
    var GICON = {
        grid:    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        smile:   '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c1 1.4 2.3 2.1 3.5 2.1s2.5-.7 3.5-2.1"/><path d="M9 9.5h.01M15 9.5h.01"/>',
        drama:   '<path d="M5 4h14v7c0 4.5-3 8-7 8s-7-3.5-7-8z"/><path d="M9 9h.01M15 9h.01"/><path d="M9 14.5c1-1 2-1.4 3-1.4s2 .4 3 1.4"/>',
        aim:     '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
        pulse:   '<path d="M3 12h4l2.5-6 4.5 12 2.5-6H21"/>',
        skull:   '<path d="M12 3a7.5 7.5 0 00-7.5 7.5c0 2.6 1.4 4.6 3 5.8V20h9v-3.7c1.6-1.2 3-3.2 3-5.8A7.5 7.5 0 0012 3z"/><path d="M9 11h.01M15 11h.01M11 16.5h2"/>',
        rocket:  '<path d="M12 2c3.5 2 5 6.5 5 10l2.5 3.5H15l-3 2.5-3-2.5H4.5L7 12c0-3.5 1.5-8 5-10z"/><circle cx="12" cy="9" r="1.6"/>',
        sword:   '<path d="M12 2.5l2 2.5v8l-2 2-2-2V5z"/><path d="M7.5 15h9"/><path d="M12 15v4.5"/><circle cx="12" cy="21" r="0.8"/>',
        finger:  '<path d="M8.5 5A8.5 8.5 0 0118.5 6.5"/><path d="M12 7.5A6.5 6.5 0 005.5 14c0 1.8.3 3.4.9 5"/><path d="M12 7.5a6.5 6.5 0 016.5 6.5c0 2.3-.4 4.3-1 6"/><path d="M12 11a3 3 0 00-3 3c0 2 .5 4 1.5 5.5"/><path d="M12 11a3 3 0 013 3c0 2.4-.3 4.6-1 6.5"/>',
        lupa:    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
        heart:   '<path d="M12 20.5s-7.5-4.8-7.5-10A4.2 4.2 0 0112 7a4.2 4.2 0 017.5 3.5c0 5.2-7.5 10-7.5 10z"/>',
        compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
        pencil:  '<path d="M4 20l1.5-5L16 4.5 19.5 8 9 18.5 4 20z"/><path d="M13.5 7l3.5 3.5"/>',
        house:   '<path d="M4 11.5l8-7 8 7V20h-5.5v-5.5h-5V20H4z"/>',
        time:    '<path d="M7 3h10v4.2L13 12l4 4.8V21H7v-4.2L11 12 7 7.2V3z"/>',
        helmet:  '<path d="M4.5 15a7.5 7.5 0 0115 0v2h-15z"/><path d="M2.5 17h19"/>',
        camera:  '<rect x="3" y="7.5" width="12" height="9" rx="2"/><path d="M15 11l6-2.5v7L15 13z"/>',
        hat:     '<path d="M3.5 16.5c2.5 1.8 14.5 1.8 17 0"/><path d="M7.5 16.5C7.5 10 9 6 12 6s4.5 4 4.5 10.5"/>',
        planet:  '<circle cx="12" cy="12" r="4.5"/><ellipse cx="12" cy="12" rx="9" ry="3.2" transform="rotate(-18 12 12)"/>',
        globe:   '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.5 2.5 14.5 0 17-2.5-2.5-2.5-14.5 0-17z"/>',
        film:    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M8 4.5v15M16 4.5v15M3.5 9H8M3.5 15H8M16 9h4.5M16 15h4.5"/>',
        tv:      '<rect x="3.5" y="6.5" width="17" height="12" rx="2"/><path d="M9 3.5l3 3 3-3"/>'
    };

    function gIcon(name) {
        if (!GICON[name]) return '';

        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1.15em;height:1.15em;display:inline-block;vertical-align:-0.18em;margin-right:0.7em">' + GICON[name] + '</svg>';
    }

    var GENRES = {
        movie: [
            { id: '',     title: 'Все жанры',      icon: 'grid' },
            { id: 35,     title: 'Комедии',        icon: 'smile' },
            { id: 18,     title: 'Драмы',          icon: 'drama' },
            { id: 28,     title: 'Боевики',        icon: 'aim' },
            { id: 53,     title: 'Триллеры',       icon: 'pulse', without: '27,14' },
            { id: 27,     title: 'Ужасы',          icon: 'skull' },
            { id: 878,    title: 'Фантастика',     icon: 'rocket', without: '14' },
            { id: 14,     title: 'Фэнтези',        icon: 'sword' },
            { id: 80,     title: 'Криминал',       icon: 'finger' },
            { id: 9648,   title: 'Детективы',      icon: 'lupa' },
            { id: 10749,  title: 'Мелодрамы',      icon: 'heart' },
            { id: 12,     title: 'Приключения',    icon: 'compass' },
            { id: 16,     title: 'Мультфильмы',    icon: 'pencil' },
            { id: 10751,  title: 'Семейные',       icon: 'house' },
            { id: 36,     title: 'Исторические',   icon: 'time' },
            { id: 10752,  title: 'Военные',        icon: 'helmet' },
            { id: 99,     title: 'Документальные', icon: 'camera' },
            { id: 37,     title: 'Вестерны',       icon: 'hat' }
        ],
        tv: [
            { id: '',     title: 'Все жанры',              icon: 'grid' },
            { id: 35,     title: 'Комедии',                icon: 'smile' },
            { id: 18,     title: 'Драмы',                  icon: 'drama' },
            { id: 80,     title: 'Криминал',               icon: 'finger' },
            { id: 9648,   title: 'Детективы',              icon: 'lupa' },
            { id: 10759,  title: 'Боевики и приключения',  icon: 'compass' },
            { id: 10765,  title: 'Фантастика и фэнтези',   icon: 'planet' },
            { id: 16,     title: 'Анимационные',           icon: 'pencil' },
            { id: 10751,  title: 'Семейные',               icon: 'house' },
            { id: 10768,  title: 'Война и политика',       icon: 'globe' },
            { id: 99,     title: 'Документальные',         icon: 'camera' },
            { id: 37,     title: 'Вестерны',               icon: 'hat' }
        ]
    };

    function tmdbUrl(path) {
        var sep = path.indexOf('?') >= 0 ? '&' : '?';

        return Lampa.TMDB.api(path + sep + 'api_key=' + Lampa.TMDB.key() + '&language=' + Lampa.Storage.field('tmdb_lang'));
    }

    // id ключевых слов TMDB не хардкодим — спрашиваем у search/keyword
    // при первом использовании и кэшируем навсегда
    var kw_network = new Lampa.Reguest();

    function resolveKeyword(phrase, call) {
        var cache = Lampa.Storage.get('cub_best_keywords', '{}');

        if (cache[phrase]) return call(cache[phrase]);

        kw_network.silent(tmdbUrl('search/keyword?query=' + encodeURIComponent(phrase)), function (json) {
            var found = null;

            ((json && json.results) || []).forEach(function (r) {
                if (!found && r.name && r.name.toLowerCase() === phrase) found = r.id;
            });

            if (!found && json && json.results && json.results.length) found = json.results[0].id;

            if (found) {
                cache[phrase] = found;
                Lampa.Storage.set('cub_best_keywords', cache);
            }

            call(found);
        }, function () {
            call(null);
        });
    }

    var FilterSource = {
        network: new Lampa.Reguest(),

        clear: function () {
            this.network.clear();
        },

        list: function (params, oncomplite, onerror) {
            var self  = this;
            var page  = params.page || 1;
            var type  = params.cub_type || 'movie';
            var batch = parseInt(pref('cub_best_batch'), 10) || DEFAULTS.cub_best_batch;
            var kw_id = '';
            var start = (page - 1) * batch + 1;

            var cfg = presetConfig();
            var first_only = !!(pref('cub_best_first_genre') && params.genre_id);
            var base_key  = [type, params.genre_id || '', params.without || '', params.kw || '', batch, pref('cub_best_preset'), cfg.min_rating, cfg.max_rating, cfg.min_votes, cfg.median || '', first_only ? 1 : 0].join('|');
            var cache_key = base_key + '|' + page;
            var hit = list_cache[cache_key];

            if (hit && Date.now() - hit.t < LIST_CACHE_TIME) {
                console.log('CUB Лучшее', 'страница ' + page + ' из кэша');

                return oncomplite(hit.data);
            }

            var ex = exhausted_cache[base_key];

            if (ex && page > ex) {
                console.log('CUB Лучшее', 'жанр вычерпан на странице ' + ex + ' — пустой ответ для страницы ' + page);

                return oncomplite({ results: [], page: page, total_pages: page });
            }

            // Активна ли сейчас именно ЭТА страница каталога. Сравнивать по
            // ссылке нельзя: в момент создания активность ещё не в стеке, а
            // компонент может получить копию параметров. Поэтому сверяем по
            // смыслу — и не на старте, а в момент показа оверлея
            function isVisible() {
                var a = Lampa.Activity.active();

                if (!a) return false;
                if (a === params) return true;
                if (a.activity && params.activity && a.activity === params.activity) return true;

                return a.component === 'category_full' &&
                    (a.source === FILTER_SOURCE || a.source === FILTER_SOURCE_LEGACY) &&
                    a.cub_type === type &&
                    String(a.genre_id || '') === String(params.genre_id || '');
            }

            console.log('CUB Лучшее', 'поиск: страница ' + page + ', глубина ' + (batch * 20));

            var items = [];
            var answers = 0;
            var need = 0;
            var total_tmdb = 1;

            var STAGE_TEXT = 'Подождите, собираем каталог' + (params.genre_title ? ': ' + params.genre_title : '') + '…';

            // Реплики ожидания в духе Hearthstone: длинный первый запуск
            // превращаем из тоски в спектакль. Последняя держится до конца
            var WAIT_LINES = [
                'Ищем сценарий…',
                'Договариваемся с режиссёром…',
                'Подбираем актёров…',
                'Работает художник по свету…',
                'Приехал костюмер…',
                'Айтишник всех посылает…',
                'Режиссёр сел в кресло…',
                'Звуковик сказал своё фи…',
                'Пиротехник на сцене…',
                'Погнали!!!'
            ];

            var wait_index = -1;
            var wait_timer = null;

            function nextWaitLine() {
                if (wait_index < WAIT_LINES.length - 1) wait_index++;

                Lampa.Loading.setText(WAIT_LINES[wait_index]);

                if (wait_index >= WAIT_LINES.length - 1 && wait_timer) {
                    clearInterval(wait_timer);
                    wait_timer = null;
                }
            }

            function run() {

            var ui_started = false;

            // Прогресс-панель по центру, под главным строббером: Lampa свой
            // лоадер прибивает в плашку внизу, поэтому перестраиваем её бокс —
            // текст, крупные проценты и широкий градиентный бар.
            // Оверлей появляется с задержкой, так что всё создаём лениво.
            var shown_pct = -1;

            function stylePanel(box) {
                if (box.find('.cub-progress').length) return;

                box.prepend('<div style="width:2.4em;height:2.4em;margin-bottom:0.9em;border-radius:50%;border:0.28em solid rgba(255,255,255,0.15);border-top-color:#9cfc87;-webkit-animation:cubspin 0.9s linear infinite;animation:cubspin 0.9s linear infinite"></div>');

                box.css({
                        position: 'fixed',
                        left: '50%',
                        top: '50%',
                        right: 'auto',
                        bottom: 'auto',
                        transform: 'translate(-50%, -50%)',
                        display: 'flex',
                        'flex-direction': 'column',
                        'align-items': 'center',
                        padding: '1.4em 2.2em',
                        'border-radius': '1.2em',
                        background: 'rgba(0,0,0,0.75)',
                        'box-shadow': '0 0.5em 2em rgba(0,0,0,0.5)'
                    });

                    box.find('.loading-layer__ico').hide();

                    box.find('.loading-layer__text').css({
                        'font-size': '1.1em',
                        opacity: 0.9,
                        margin: '0 0 0.6em 0'
                    });

                box.append(
                    '<div class="cub-progress-pct" style="font-size:1.8em;font-weight:600;color:#9cfc87;line-height:1;margin-bottom:0.55em;font-variant-numeric:tabular-nums;min-width:2.8em;text-align:center">…</div>' +
                    '<div class="cub-progress" style="width:26em;max-width:80vw;height:0.55em;background:rgba(255,255,255,0.15);border-radius:1em;overflow:hidden">' +
                    '<div style="height:100%;width:0%;border-radius:1em;background:linear-gradient(90deg,#4ade80,#9cfc87);box-shadow:0 0 0.8em rgba(156,252,135,0.6);transition:width 0.25s"></div>' +
                    '</div>' +
                    '<div style="margin-top:0.8em;font-size:0.85em;opacity:0.6">честный рейтинг сообщества CUB</div>'
                );
            }

            // Оверлей запускаем отложенно и только когда страница реально на
            // экране (фоновые пересоздания активностей молчат); после
            // появления сразу стилизуем, чтобы голая плашка не висела ни секунды
            var panel_timer = setInterval(function () {
                if (!ui_started) {
                    if (!isVisible()) return;

                    ui_started = true;

                    Lampa.Loading.start(function () {}, STAGE_TEXT);
                    $('body').addClass('cub--loading');

                    wait_timer = setInterval(nextWaitLine, 4000);

                    return;
                }

                var box = $('.loading-layer__box');

                if (box.length) {
                    stylePanel(box);
                    clearInterval(panel_timer);
                    panel_timer = null;
                }
            }, 150);

            function setProgress(pct) {
                if (!ui_started) return;

                var box = $('.loading-layer__box');
                if (!box.length) return;

                stylePanel(box);

                // DOM трогаем только при смене целого процента,
                // иначе на ТВ текст заметно мерцает
                pct = Math.min(100, Math.round(pct));
                if (pct === shown_pct) return;
                shown_pct = pct;

                box.find('.cub-progress-pct').text(pct + '%');
                box.find('.cub-progress > div').css('width', pct + '%');
            }

            function done(result) {
                if (panel_timer) {
                    clearInterval(panel_timer);
                    panel_timer = null;
                }

                if (wait_timer) {
                    clearInterval(wait_timer);
                    wait_timer = null;
                }

                if (ui_started) {
                    Lampa.Loading.stop();

                    $('body').removeClass('cub--loading');
                }

                if (result) oncomplite(result);
                else onerror();
            }

            function pageUrl(p) {
                var u = 'discover/' + type + '?sort_by=popularity.desc&vote_count.gte=10&page=' + p;

                if (params.genre_id) u += '&with_genres=' + params.genre_id;
                if (params.without)  u += '&without_genres=' + params.without;
                if (kw_id)           u += '&with_keywords=' + kw_id;

                return tmdbUrl(u);
            }

            function pagesDone() {
                // popularity у TMDB плавает между запросами, из-за чего
                // тайтлы могут повторяться на соседних страницах — чистим
                var seen = {};
                var uniq = [];

                items.forEach(function (it) {
                    if (it && it.id && !seen[it.id]) {
                        seen[it.id] = 1;
                        uniq.push(it);
                    }
                });

                if (!uniq.length) return done(null);

                rate(uniq);
            }

            function loadPage(p) {
                need++;

                self.network.silent(pageUrl(p), function (json) {
                    answers++;

                    if (json) {
                        total_tmdb = Math.min(json.total_pages || 1, 500);
                        items = items.concat(json.results || []);
                    }

                    setProgress(answers / need * 10);

                    if (answers == need) pagesDone();
                }, function () {
                    answers++;

                    setProgress(answers / need * 10);

                    if (answers == need) pagesDone();
                });
            }

            function rate(list) {
                var left  = list.length;
                var total = list.length;


                function step() {
                    setProgress(10 + (total - left) / total * 90);

                    if (left === 0) finish(list);
                }

                list.forEach(function (item) {
                    item.source = 'tmdb';

                    var key = cardKey(item);

                    if (!key) {
                        item.cub_rating = 0;
                        item.cub_votes  = 0;
                        left--;
                        step();
                        return;
                    }

                    getRating(key, function (res) {
                        item.cub_rating = res.r || 0;
                        item.cub_votes  = res.n || 0;
                        item.cub_median = res.d || '';
                        item.cub_positive = (typeof res.p === 'number') ? res.p : null;

                        left--;
                        step();
                    });
                });
            }

            function finish(list) {
                var ready = list.filter(function (a) {
                    if (a.cub_votes < cfg.min_votes) return false;
                    if (a.cub_rating < cfg.min_rating || a.cub_rating >= cfg.max_rating) return false;
                    if (cfg.median) {
                        // "неоднозначно" = срединная реакция 🤔 ИЛИ раскол:
                        // восторгов меньше 60% (старые записи кэша без поля
                        // p проходят только по медиане — рассосётся за сутки)
                        var split = a.cub_positive !== null && a.cub_positive < WEIRD_POSITIVE_MAX;

                        if (a.cub_median !== cfg.median && !split) return false;
                    }

                    // "главный жанр": выбранный жанр должен стоять первым
                    // в списке жанров TMDB (порядок там — по значимости)
                    if (first_only && (!a.genre_ids || String(a.genre_ids[0]) !== String(params.genre_id))) return false;

                    return true;
                });

                // жанр почти вычерпан — глубже не ходим
                var exhausted = ready.length < CATALOG_PAGE_YIELD;

                if (exhausted) {
                    exhausted_cache[base_key] = Math.min(exhausted_cache[base_key] || page, page);

                    console.log('CUB Лучшее', 'жанр вычерпан: страница ' + page + ' дала ' + ready.length + ' тайтлов');
                }

                if (!ready.length) {
                    // пустая ДОгрузка — не ошибка, а терминальный пустой ответ:
                    // на ошибке Lampa продолжила бы дёргать следующие страницы
                    if (page > 1) {
                        var empty_payload = { results: [], page: page, total_pages: page };

                        list_cache[cache_key] = { t: Date.now(), data: empty_payload };

                        return done(empty_payload);
                    }

                    return done(null);
                }

                ready.sort(function (a, b) {
                    // при равном рейтинге выше тот, кого оценило больше людей
                    return (b.cub_rating - a.cub_rating) || (b.cub_votes - a.cub_votes);
                });

                // псевдо-тайтл "Загрузить ещё" в конец выдачи (см. decorateMoreCard)
                if (!exhausted) {
                    ready.push({ cub_more: true, id: 'cub_more', title: 'Загрузить ещё', poster_path: '', release_date: '' });
                }

                var payload = {
                    results: ready,
                    page: page,
                    total_pages: exhausted ? page : Math.max(page, Math.ceil(total_tmdb / batch))
                };

                list_cache[cache_key] = { t: Date.now(), data: payload };

                done(payload);
            }

            function begin() {
                for (var i = 0; i < batch; i++) {
                    if (start + i <= 500) loadPage(start + i);
                }

                if (!need) done(null);
            }

            if (params.kw) {
                resolveKeyword(params.kw, function (id) {
                    if (!id) return done(null);

                    kw_id = id;
                    begin();
                });
            }
            else begin();

            } // конец run()

            // Плитка "Загрузить ещё" уже стоит в конце сетки (пришла вместе
            // с данными страницы). Lampa ждёт ответ на свой упреждающий
            // запрос и не повторяет его — просто паркуем поиск до нажатия:
            // после него результаты приедут штатным resolve, и Lampa сама
            // дорисует их в сетку
            if (page > 1 && isVisible()) {
                pending_more = { run: run };

                return;
            }

            run();
        }
    };

    // Ужасы отфильтровываются из всех КОНКРЕТНЫХ жанров, кроме самого
    // раздела "Ужасы"; "Все жанры" остаются действительно всеми
    function buildWithout(genre) {
        var parts = String(genre.without || '').split(',').filter(Boolean);
        var ids   = String(genre.id || '').split(',');

        if (genre.id && ids.indexOf('27') < 0 && parts.indexOf('27') < 0) parts.push('27');

        return parts.join(',');
    }

    function openCatalog(type, genre) {
        Lampa.Activity.push({
            component: 'category_full',
            source: FILTER_SOURCE,
            title: 'CUB Лучшее · ' + (type == 'movie' ? 'Фильмы' : 'Сериалы') + (genre.id ? ' · ' + (genre.genre_title || genre.title) : ''),
            cub_type: type,
            genre_id: genre.id,
            without: buildWithout(genre),
            genre_title: genre.genre_title || genre.title || '',
            kw: genre.kw || '',
            page: 1
        });
    }

    function openGenreSelect(type) {
        Lampa.Select.show({
            title: 'Жанр',
            items: GENRES[type].map(function (g) {
                return { title: gIcon(g.icon) + g.title, id: g.id, without: g.without, kw: g.kw, genre_title: g.title };
            }),
            onSelect: function (a) {
                openCatalog(type, a);
            },
            onBack: openTypeSelect
        });
    }

    function openTypeSelect() {
        Lampa.Select.show({
            title: 'CUB Лучшее',
            items: [
                { title: gIcon('film') + 'Фильмы',  type: 'movie' },
                { title: gIcon('tv') + 'Сериалы', type: 'tv' }
            ],
            onSelect: function (a) {
                openGenreSelect(a.type);
            },
            onBack: function () {
                Lampa.Controller.toggle('menu');
            }
        });
    }

    function addMenuButton() {
        var item = $('<li class="menu__item selector">' +
            '<div class="menu__ico">' + ICON_STAR + '</div>' +
            '<div class="menu__text">CUB Лучшее</div>' +
            '</li>');

        item.on('hover:enter', openTypeSelect);

        $('.menu .menu__list').eq(0).append(item);
    }

    // ---------- настройки ----------

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: PLUGIN,
            name: 'CUB Лучшее',
            icon: starIcon('#ffffff')
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: 'cub_best_cards', type: 'trigger', default: DEFAULTS.cub_best_cards },
            field: { name: 'Рейтинг на плитках', description: 'Заменять рейтинг TMDB на плитках рейтингом CUB' }
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: 'cub_best_full', type: 'trigger', default: DEFAULTS.cub_best_full },
            field: { name: 'Рейтинг в карточке', description: 'Показывать бейдж CUB на экране деталей' }
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: {
                name: 'cub_best_min_votes',
                type: 'select',
                values: { 5: '5', 10: '10', 20: '20', 50: '50', 100: '100' },
                default: DEFAULTS.cub_best_min_votes
            },
            field: { name: 'Минимум реакций', description: 'Если реакций меньше — рейтинг CUB не показывается ни на плитке, ни в карточке' }
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: {
                name: 'cub_best_batch',
                type: 'select',
                values: { 25: '500 тайтлов', 50: '1000 тайтлов', 100: '2000 тайтлов' },
                default: DEFAULTS.cub_best_batch
            },
            field: { name: 'Глубина поиска', description: 'Сколько кандидатов просматривает одна страница «CUB Лучшее». Глубже — полнее выдача, но дольше первая загрузка. На слабых ТВ лучше 500' }
        });

        // Выбор пресета — свой Select с описанием под каждым пунктом:
        // штатный select настроек подзаголовки не пробрасывает
        var PRESET_TITLES = {
            master: '🏆 Мастерство',
            solid:  '👌 Достойно',
            weird:  '🤔 Неоднозначно'
        };

        var PRESET_DESCR = {
            master: 'Рейтинг CUB 8.0 и выше, не меньше 100 реакций. Жёсткий фестивальный отбор: только проверенное величие',
            solid:  'Рейтинг CUB 7.0 и выше, не меньше 50 реакций. Сделано на совесть — от крепкого кино до шедевров',
            weird:  'Спорное кино, расколовшее зрителей: восторгов меньше 60%, либо срединная реакция — «задумался» 🤔. Рейтинг 6.0 и выше, не меньше 20 реакций'
        };

        var preset_row = null;

        function presetRowUpdate() {
            if (!preset_row) return;

            preset_row.find('.settings-param__value').text(PRESET_TITLES[pref('cub_best_preset')] || PRESET_TITLES.master);
        }

        function openPresetSelect() {
            var current = pref('cub_best_preset');
            var enabled = Lampa.Controller.enabled().name;

            Lampa.Select.show({
                title: '🎯 Отбор',
                items: ['master', 'solid', 'weird'].map(function (k) {
                    return {
                        title: PRESET_TITLES[k],
                        subtitle: PRESET_DESCR[k],
                        value: k,
                        selected: k === current
                    };
                }),
                onBack: function () {
                    Lampa.Controller.toggle(enabled);
                },
                onSelect: function (a) {
                    Lampa.Storage.set('cub_best_preset', a.value);

                    presetRowUpdate();

                    Lampa.Controller.toggle(enabled);
                }
            });
        }

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: 'cub_best_preset_btn', type: 'button' },
            field: { name: '🎯 Отбор', description: 'Какое кино попадает в «CUB Лучшее». Выдача всегда отсортирована по рейтингу CUB, при равенстве — по числу реакций' },
            onRender: function (item) {
                preset_row = item;

                if (!item.find('.settings-param__value').length) {
                    // отступ задаём сами: скины дают его только строкам-селектам
                    item.find('.settings-param__name').after('<div class="settings-param__value" style="margin-top:0.4em"></div>');
                }

                presetRowUpdate();
            },
            onChange: openPresetSelect
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: 'cub_best_first_genre', type: 'trigger', default: DEFAULTS.cub_best_first_genre },
            field: { name: 'Только главный жанр', description: 'Показывать лишь тайтлы, у которых выбранный жанр стоит первым в TMDB — обычно это доминирующий жанр. Чище по жанру, но выдача заметно короче: «Молчание ягнят» уедет из триллеров в криминал' }
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: 'cub_best_clear_cache', type: 'button' },
            field: { name: 'Очистить кэш', description: 'Сбросить кэш рейтингов и страниц каталога — тест с чистого листа, как у нового пользователя' },
            onChange: function () {
                Lampa.Storage.set(CACHE_KEY, '{}');
                Lampa.Storage.set('cub_best_keywords', '{}');

                persisted = Lampa.Storage.cache(CACHE_KEY, CACHE_MAX, {});
                list_cache = {};
                exhausted_cache = {};

                Lampa.Noty.show('Кэш «CUB Лучшее» очищен');
            }
        });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: 'cub_best_reset', type: 'button' },
            field: { name: 'Сбросить настройки', description: 'Вернуть все настройки «CUB Лучшее» к значениям по умолчанию. Кэш не трогает' },
            onChange: function () {
                for (var key in DEFAULTS) {
                    if (DEFAULTS.hasOwnProperty(key)) Lampa.Storage.set(key, DEFAULTS[key]);
                }

                // перерисовать открытую страницу настроек с новыми значениями
                if (Lampa.Settings && Lampa.Settings.update) Lampa.Settings.update();

                Lampa.Noty.show('Настройки «CUB Лучшее» сброшены');
            }
        });
    }

    // ---------- старт ----------

    // При ручном добавлении по URL Lampa не знает имени плагина и пишет
    // "Без названия" — проставляем имя своей записи в списке расширений сами
    function setOwnName() {
        var list = Lampa.Storage.get('plugins', '[]');
        var changed = false;

        list.forEach(function (p) {
            if (p && p.url && (p.url.indexOf('cub-best.js') >= 0 || p.url.indexOf('cub_best.js') >= 0 || p.url.indexOf('cub_rating.js') >= 0) && p.name !== 'CUB Лучшее') {
                p.name = 'CUB Лучшее';
                changed = true;
            }
        });

        if (changed) Lampa.Storage.set('plugins', list);
    }

    function startPlugin() {
        console.log('CUB Лучшее', 'v' + VERSION + ' запущен');

        Lampa.Storage.set('cub_rating_cache', '{}');    // чистим кэши старых версий
        Lampa.Storage.set('cub_rating_cache_v2', '{}');

        // пока грузится "CUB Лучшее", штатный строббер активности прячем —
        // прогресс-бара достаточно
        var style = document.createElement('style');
        style.innerText = 'body.cub--loading .activity__loader{display:none!important} @-webkit-keyframes cubspin{to{-webkit-transform:rotate(360deg)}} @keyframes cubspin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);

        setOwnName();

        Lampa.Api.sources[FILTER_SOURCE] = FilterSource;
        Lampa.Api.sources[FILTER_SOURCE_LEGACY] = FilterSource;

        addSettings();
        addMenuButton();
        if (pref('cub_best_cards')) startCards();
        startFull();

        console.log('CUB Rating', 'plugin started');
    }

    if (window.appready) startPlugin();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();
