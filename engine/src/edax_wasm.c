/*
 * Browser (WebAssembly) entry points for Edax.
 *
 * Edax is (c) Richard Delorme, GPL-3.0: https://github.com/abulmo/edax-reversi
 * This file builds the whole Edax engine as one unit (all.c) and exposes two
 * functions to JavaScript. It runs single-threaded (n_task = 1), so no
 * pthreads are needed in the browser.
 *
 * Compile with -Dmain=edax_main so Edax's own main() is not used.
 */
#include "all.c"
#include <emscripten.h>

static Search g_search;
static bool g_ready = false;
static char g_out[32768];

static void quiet_observer(Result *r) { (void) r; }

static int square_to_text(int x, char *buf)
{
	if (x == PASS) { buf[0] = 'p'; buf[1] = 's'; return 2; }
	if (x < 0 || x >= 64) { buf[0] = '-'; buf[1] = '-'; return 2; }
	buf[0] = (char) ('a' + (x & 7));
	buf[1] = (char) ('1' + (x >> 3));
	return 2;
}

/* Load eval weights and allocate the search. hash_bits: 18..24 (2^bits entries). */
EMSCRIPTEN_KEEPALIVE int edax_init(int hash_bits)
{
	if (g_ready) return 1;
	options.n_task = 1;
	options.verbosity = 0;
	options.hash_table_size = hash_bits;
	options_bound();

	edge_stability_init();
	statistics_init();
	eval_open(options.eval_file); /* data/eval.dat in the virtual file system */

	search_init(&g_search);
	g_search.observer = quiet_observer;
	g_search.options.verbosity = 0;
	g_ready = true;
	return 1;
}

/*
 * Analyse a position.
 *   board: 64 chars a1..h8 ('X' black, 'O' white, '-' empty), a space, then side to move ('X'/'O').
 *   level: Edax level (e.g. 21).
 *   n:     how many moves to score (best first). Use 60 for all moves.
 * Returns JSON:
 *   {"empties":E,"moves":[{"move":"f5","score":2,"depth":21,"selectivity":73,"pv":"f5d6c3"},...]}
 * Scores are from the side to move, in discs.
 */
EMSCRIPTEN_KEEPALIVE const char *edax_analyze(const char *board_text, int level, int n)
{
	Board board;
	Search *s = &g_search;
	int i, k, pos;

	if (!g_ready) return "{\"error\":\"not initialised\"}";
	int player = board_set(&board, board_text);
	if (player == EMPTY) return "{\"error\":\"bad board\"}";

	search_set_board(s, &board, player);
	if (level < 0) level = 0;
	if (level > 60) level = 60;
	search_set_level(s, level, s->n_empties);
	if (n > s->movelist.n_moves) n = s->movelist.n_moves;

	pos = snprintf(g_out, sizeof g_out, "{\"empties\":%d,\"moves\":[", s->n_empties);

	for (i = 0; i < n; ++i) {
		search_set_game_time(s, TIME_MAX);
		/* Same as Edax's "hint": exact scores when more moves follow. */
		if (i < n - 1) s->options.multipv_depth = 60;
		search_run(s);
		s->options.multipv_depth = MULTIPV_DEPTH;

		Result *r = s->result;
		char pv[2 * GAME_SIZE + 1];
		int p = 0;
		for (k = 0; k < r->pv.n_moves && p < 2 * GAME_SIZE; ++k) p += square_to_text(r->pv.move[k], pv + p);
		pv[p] = '\0';
		char mv[3];
		square_to_text(r->move, mv);
		mv[2] = '\0';

		pos += snprintf(g_out + pos, sizeof g_out - pos,
			"%s{\"move\":\"%s\",\"score\":%d,\"depth\":%d,\"selectivity\":%d,\"pv\":\"%s\"}",
			i ? "," : "", mv, r->score, r->depth, selectivity_table[r->selectivity].percent, pv);

		if (search_get_state(s) != STOP_END) break;
		movelist_exclude(&s->movelist, r->move);
	}

	snprintf(g_out + pos, sizeof g_out - pos, "]}");
	return g_out;
}
