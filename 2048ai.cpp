/*
 * 2048 Strong AI (C++)
 *
 * Expectimax search with 64-bit bitboards, precomputed move tables and
 * per-row heuristic tables. Architecture and heuristic formulas are based on
 * nneonneo/2048-ai (MIT License): https://github.com/nneonneo/2048-ai
 *
 * Build (MSVC x64, from a "Developer Command Prompt" or after calling
 * vcvarsall.bat x64):
 *   cl /O2 /EHsc /std:c++17 /D_CRT_SECURE_NO_WARNINGS 2048ai.cpp
 *
 * Usage:
 *   2048ai.exe bench [--games N] [--seed S] [--budget N] [--depth N]
 *       Runs N self-play games and prints the tile distribution.
 *   2048ai.exe move [--budget N] [--depth N]
 *       Reads 16 integers (row-major, tile VALUES like 2/4/8/16 or 0) from
 *       stdin and prints the best move: 0=up 1=down 2=left 3=right, -1 if
 *       there are no legal moves.
 *   2048ai.exe selftest
 *       Validates the bitboard move logic against a naive reference on
 *       20000 random boards.
 */

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

typedef uint64_t board_t;
typedef uint16_t row_t;

static const uint64_t ROW_MASK = 0xFFFFULL;
static const uint64_t COL_MASK = 0x000F0F0F0F0F0F0FULL;

static row_t row_left_table[65536];
static row_t row_right_table[65536];
static board_t col_up_table[65536];
static board_t col_down_table[65536];
static float heur_score_table[65536];
static float score_table[65536];

// Heuristic scoring settings (nneonneo)
static const float SCORE_LOST_PENALTY = 200000.0f;
static const float SCORE_MONOTONICITY_POWER = 4.0f;
static const float SCORE_MONOTONICITY_WEIGHT = 47.0f;
static const float SCORE_SUM_POWER = 3.5f;
static const float SCORE_SUM_WEIGHT = 11.0f;
static const float SCORE_MERGES_WEIGHT = 700.0f;
static const float SCORE_EMPTY_WEIGHT = 270.0f;

static const float CPROB_THRESH_BASE = 0.0001f;
static const int CACHE_DEPTH_LIMIT = 15;

static inline row_t reverse_row(row_t row) {
    return (row_t)((row >> 12) | ((row >> 4) & 0x00F0) |
                   ((row << 4) & 0x0F00) | (row << 12));
}

static inline board_t transpose(board_t x) {
    board_t a1 = x & 0xF0F00F0FF0F00F0FULL;
    board_t a2 = x & 0x0000F0F00000F0F0ULL;
    board_t a3 = x & 0x0F0F00000F0F0000ULL;
    board_t a = a1 | (a2 << 12) | (a3 >> 12);
    board_t b1 = a & 0xFF00FF0000FF00FFULL;
    board_t b2 = a & 0x00FF00FF00000000ULL;
    board_t b3 = a & 0x00000000FF00FF00ULL;
    return b1 | (b2 >> 24) | (b3 << 24);
}

static inline board_t unpack_col(unsigned row) {
    board_t tmp = row;
    return (tmp | (tmp << 12) | (tmp << 24) | (tmp << 36)) & COL_MASK;
}

static void init_tables() {
    for (unsigned row = 0; row < 65536; ++row) {
        unsigned line[4] = {
            (row >> 0) & 0xf,
            (row >> 4) & 0xf,
            (row >> 8) & 0xf,
            (row >> 12) & 0xf,
        };

        // Score: total value of the tile including all intermediate merges
        float score = 0.0f;
        for (int i = 0; i < 4; ++i) {
            int rank = line[i];
            if (rank >= 2) score += (float)((rank - 1) * (1 << rank));
        }
        score_table[row] = score;

        // Heuristic score
        float sum = 0;
        int empty = 0;
        int merges = 0;
        int prev = 0;
        int counter = 0;
        for (int i = 0; i < 4; ++i) {
            int rank = line[i];
            sum += (float)pow((double)rank, (double)SCORE_SUM_POWER);
            if (rank == 0) {
                empty++;
            } else {
                if (prev == rank) {
                    counter++;
                } else if (counter > 0) {
                    merges += 1 + counter;
                    counter = 0;
                }
                prev = rank;
            }
        }
        if (counter > 0) merges += 1 + counter;

        float monotonicity_left = 0;
        float monotonicity_right = 0;
        for (int i = 1; i < 4; ++i) {
            if (line[i - 1] > line[i]) {
                monotonicity_left +=
                    (float)pow((double)line[i - 1], (double)SCORE_MONOTONICITY_POWER) -
                    (float)pow((double)line[i], (double)SCORE_MONOTONICITY_POWER);
            } else {
                monotonicity_right +=
                    (float)pow((double)line[i], (double)SCORE_MONOTONICITY_POWER) -
                    (float)pow((double)line[i - 1], (double)SCORE_MONOTONICITY_POWER);
            }
        }

        heur_score_table[row] =
            SCORE_LOST_PENALTY +
            SCORE_EMPTY_WEIGHT * (float)empty +
            SCORE_MERGES_WEIGHT * (float)merges -
            SCORE_MONOTONICITY_WEIGHT * std::min(monotonicity_left, monotonicity_right) -
            SCORE_SUM_WEIGHT * sum;

        // Execute a move to the left
        for (int i = 0; i < 3; ++i) {
            int j;
            for (j = i + 1; j < 4; ++j) {
                if (line[j] != 0) break;
            }
            if (j == 4) break; // no more tiles to the right
            if (line[i] == 0) {
                line[i] = line[j];
                line[j] = 0;
                i--; // retry this entry
            } else if (line[i] == line[j]) {
                if (line[i] != 0xf) {
                    // Pretend that 32768 + 32768 = 32768 (representational limit)
                    line[i]++;
                }
                line[j] = 0;
            }
        }
        row_t result = (row_t)((line[0] << 0) | (line[1] << 4) |
                               (line[2] << 8) | (line[3] << 12));
        row_t rev_result = reverse_row(result);
        unsigned rev_row = reverse_row((row_t)row);
        row_left_table[row] = (row_t)(row ^ result);
        row_right_table[rev_row] = (row_t)(rev_row ^ rev_result);
        col_up_table[row] = unpack_col(row) ^ unpack_col(result);
        col_down_table[rev_row] = unpack_col(rev_row) ^ unpack_col(rev_result);
    }
}

static inline board_t execute_move_0(board_t board) { // up
    board_t ret = board;
    board_t t = transpose(board);
    ret ^= col_up_table[(t >> 0) & ROW_MASK] << 0;
    ret ^= col_up_table[(t >> 16) & ROW_MASK] << 4;
    ret ^= col_up_table[(t >> 32) & ROW_MASK] << 8;
    ret ^= col_up_table[(t >> 48) & ROW_MASK] << 12;
    return ret;
}

static inline board_t execute_move_1(board_t board) { // down
    board_t ret = board;
    board_t t = transpose(board);
    ret ^= col_down_table[(t >> 0) & ROW_MASK] << 0;
    ret ^= col_down_table[(t >> 16) & ROW_MASK] << 4;
    ret ^= col_down_table[(t >> 32) & ROW_MASK] << 8;
    ret ^= col_down_table[(t >> 48) & ROW_MASK] << 12;
    return ret;
}

static inline board_t execute_move_2(board_t board) { // left
    board_t ret = board;
    ret ^= (board_t)row_left_table[(board >> 0) & ROW_MASK] << 0;
    ret ^= (board_t)row_left_table[(board >> 16) & ROW_MASK] << 16;
    ret ^= (board_t)row_left_table[(board >> 32) & ROW_MASK] << 32;
    ret ^= (board_t)row_left_table[(board >> 48) & ROW_MASK] << 48;
    return ret;
}

static inline board_t execute_move_3(board_t board) { // right
    board_t ret = board;
    ret ^= (board_t)row_right_table[(board >> 0) & ROW_MASK] << 0;
    ret ^= (board_t)row_right_table[(board >> 16) & ROW_MASK] << 16;
    ret ^= (board_t)row_right_table[(board >> 32) & ROW_MASK] << 32;
    ret ^= (board_t)row_right_table[(board >> 48) & ROW_MASK] << 48;
    return ret;
}

static inline board_t execute_move(int move, board_t board) {
    switch (move) {
        case 0: return execute_move_0(board);
        case 1: return execute_move_1(board);
        case 2: return execute_move_2(board);
        case 3: return execute_move_3(board);
        default: return ~0ULL;
    }
}

static inline int get_max_rank(board_t board) {
    int maxrank = 0;
    while (board) {
        maxrank = std::max(maxrank, (int)(board & 0xf));
        board >>= 4;
    }
    return maxrank;
}

static inline int count_empty(board_t x) {
    x |= (x >> 2) & 0x3333333333333333ULL;
    x |= (x >> 1);
    x = ~x & 0x1111111111111111ULL;
    x += x >> 32;
    x += x >> 16;
    x += x >> 8;
    x += x >> 4;
    return (int)(x & 0xf);
}

static inline int count_distinct_tiles(board_t board) {
    uint16_t bitset = 0;
    while (board) {
        bitset |= (uint16_t)(1 << (board & 0xf));
        board >>= 4;
    }
    bitset >>= 1; // don't count empty tiles
    int count = 0;
    while (bitset) {
        bitset &= (uint16_t)(bitset - 1);
        count++;
    }
    return count;
}

static inline float score_helper(board_t board, const float* table) {
    return table[(board >> 0) & ROW_MASK] +
           table[(board >> 16) & ROW_MASK] +
           table[(board >> 32) & ROW_MASK] +
           table[(board >> 48) & ROW_MASK];
}

static inline float score_heur_board(board_t board) {
    return score_helper(board, heur_score_table) +
           score_helper(transpose(board), heur_score_table);
}

static inline float score_board(board_t board) {
    return score_helper(board, score_table);
}

struct trans_table_entry_t {
    uint8_t depth;
    float heuristic;
};

struct eval_state {
    std::unordered_map<board_t, trans_table_entry_t> trans_table;
    int curdepth;
    int maxdepth;
    long long moves_evaled;
    long long budget; // 0 = unlimited
    int depth_limit;

    eval_state() : curdepth(0), maxdepth(0), moves_evaled(0), budget(0), depth_limit(0) {}
};

static float score_move_node(eval_state& state, board_t board, float cprob);
static float score_tilechoose_node(eval_state& state, board_t board, float cprob);

static float score_move_node(eval_state& state, board_t board, float cprob) {
    if (state.budget > 0 && state.moves_evaled >= state.budget) {
        return score_heur_board(board);
    }
    float best = 0.0f;
    state.curdepth++;
    for (int move = 0; move < 4; ++move) {
        board_t newboard = execute_move(move, board);
        state.moves_evaled++;
        if (board != newboard) {
            best = std::max(best, score_tilechoose_node(state, newboard, cprob));
        }
        if (state.budget > 0 && state.moves_evaled >= state.budget) break;
    }
    state.curdepth--;
    return best;
}

static float score_tilechoose_node(eval_state& state, board_t board, float cprob) {
    if (cprob < CPROB_THRESH_BASE || state.curdepth >= state.depth_limit) {
        state.maxdepth = std::max(state.curdepth, state.maxdepth);
        return score_heur_board(board);
    }
    if (state.curdepth < CACHE_DEPTH_LIMIT) {
        std::unordered_map<board_t, trans_table_entry_t>::iterator i =
            state.trans_table.find(board);
        if (i != state.trans_table.end()) {
            trans_table_entry_t entry = i->second;
            if (entry.depth <= state.curdepth) {
                return entry.heuristic;
            }
        }
    }
    int num_open = count_empty(board);
    cprob /= (float)num_open;
    float res = 0.0f;
    board_t tmp = board;
    board_t tile_2 = 1;
    while (tile_2) {
        if ((tmp & 0xf) == 0) {
            res += score_move_node(state, board | tile_2, cprob * 0.9f) * 0.9f;
            res += score_move_node(state, board | (tile_2 << 1), cprob * 0.1f) * 0.1f;
        }
        tmp >>= 4;
        tile_2 <<= 4;
    }
    res = res / (float)num_open;
    if (state.curdepth < CACHE_DEPTH_LIMIT) {
        trans_table_entry_t entry;
        entry.depth = (uint8_t)state.curdepth;
        entry.heuristic = res;
        state.trans_table[board] = entry;
    }
    return res;
}

static float score_toplevel_move(board_t board, int move, long long budget) {
    board_t newboard = execute_move(move, board);
    if (board == newboard) return 0;
    eval_state state;
    state.depth_limit = std::max(3, count_distinct_tiles(board) - 2);
    state.budget = budget;
    return score_tilechoose_node(state, newboard, 1.0f) + 1e-6f;
}

static int find_best_move(board_t board, long long budget) {
    int bestmove = -1;
    float best = 0;
    for (int move = 0; move < 4; ++move) {
        float res = score_toplevel_move(board, move, budget);
        if (res > best) {
            best = res;
            bestmove = move;
        }
    }
    return bestmove;
}

// ---------- game simulation ----------
static uint64_t rng_state = 0x9E3779B97F4A7C15ULL;

static inline uint64_t rng_next() {
    uint64_t x = rng_state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rng_state = x;
    return x * 0x2545F4914F6CDD1DULL;
}

static inline board_t draw_tile() {
    return (rng_next() % 10 < 9) ? 1 : 2;
}

static inline board_t insert_tile_rand(board_t board, board_t tile) {
    int index = (int)(rng_next() % (unsigned)count_empty(board));
    board_t tmp = board;
    while (true) {
        while ((tmp & 0xf) != 0) {
            tmp >>= 4;
            tile <<= 4;
        }
        if (index == 0) break;
        --index;
        tmp >>= 4;
        tile <<= 4;
    }
    return board | tile;
}

static inline board_t initial_board() {
    board_t board = draw_tile() << (4 * (rng_next() % 16));
    return insert_tile_rand(board, draw_tile());
}

struct game_result_t {
    int max_rank;
    long long score;
    int moves;
};

static game_result_t play_game(long long budget) {
    board_t board = initial_board();
    int moveno = 0;
    float score = 0.0f;
    while (true) {
        int move = find_best_move(board, budget);
        if (move < 0) break;
        board_t newboard = execute_move(move, board);
        if (board == newboard) break;
        score += score_board(newboard) - score_board(board);
        board = insert_tile_rand(newboard, draw_tile());
        moveno++;
    }
    game_result_t r;
    r.max_rank = get_max_rank(board);
    r.score = (long long)(score + 0.5);
    r.moves = moveno;
    return r;
}

// ---------- naive reference for selftest ----------
static void naive_slide(unsigned line[4], int dir_reversed, int& gained) {
    unsigned cells[4];
    int n = 0;
    if (dir_reversed) {
        for (int i = 3; i >= 0; --i) if (line[i]) cells[n++] = line[i];
    } else {
        for (int i = 0; i < 4; ++i) if (line[i]) cells[n++] = line[i];
    }
    unsigned out[4] = {0, 0, 0, 0};
    int o = 0;
    for (int i = 0; i < n; ++i) {
        if (i + 1 < n && cells[i] == cells[i + 1]) {
            out[o++] = cells[i] + 1;
            gained += (int)(1 << (cells[i] + 1));
            i++;
        } else {
            out[o++] = cells[i];
        }
    }
    if (dir_reversed) {
        for (int i = 0; i < 4; ++i) line[3 - i] = out[i];
    } else {
        for (int i = 0; i < 4; ++i) line[i] = out[i];
    }
}

static board_t naive_move(board_t board, int move) {
    unsigned g[16];
    for (int i = 0; i < 16; ++i) g[i] = (unsigned)((board >> (4 * i)) & 0xf);
    int gained = 0;
    if (move == 2 || move == 3) { // left / right
        for (int r = 0; r < 4; ++r) {
            unsigned line[4] = {g[r * 4], g[r * 4 + 1], g[r * 4 + 2], g[r * 4 + 3]};
            naive_slide(line, move == 3, gained);
            for (int c = 0; c < 4; ++c) g[r * 4 + c] = line[c];
        }
    } else { // up / down
        for (int c = 0; c < 4; ++c) {
            unsigned line[4] = {g[c], g[4 + c], g[8 + c], g[12 + c]};
            naive_slide(line, move == 1, gained);
            for (int r = 0; r < 4; ++r) g[r * 4 + c] = line[r];
        }
    }
    board_t out = 0;
    for (int i = 0; i < 16; ++i) out |= (board_t)g[i] << (4 * i);
    return out;
}

static int selftest() {
    for (int t = 0; t < 20000; ++t) {
        board_t board = 0;
        for (int i = 0; i < 16; ++i) {
            if (rng_next() % 3 != 0) board |= (board_t)(rng_next() % 12) << (4 * i);
        }
        for (int m = 0; m < 4; ++m) {
            board_t fast = execute_move(m, board);
            board_t naive = naive_move(board, m);
            if (fast != naive) {
                printf("SELFTEST FAILED move=%d board=%016llx fast=%016llx naive=%016llx\n",
                       m, (unsigned long long)board, (unsigned long long)fast,
                       (unsigned long long)naive);
                return 1;
            }
        }
    }
    printf("selftest passed: 20000 boards x 4 directions\n");
    return 0;
}

// ---------- CLI ----------
static long long parse_budget(int argc, char** argv, int& i) {
    if (i + 1 < argc) {
        long long v = atoll(argv[i + 1]);
        if (v >= 0) {
            i++;
            return v;
        }
    }
    return 0;
}

static int run_bench(int games, unsigned long long seed, long long budget) {
    rng_state = seed ? seed : (uint64_t)time(NULL);
    int count[6] = {0}; // >=2, >=4, >=8, >=16, >=32, >=64 (ranks 1..6 => tiles 2..64)
    long long total_score = 0;
    long long total_moves = 0;
    std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
    int hist[16] = {0};
    for (int g = 0; g < games; ++g) {
        game_result_t r = play_game(budget);
        total_score += r.score;
        total_moves += r.moves;
        if (r.max_rank >= 11) count[5]++;
        if (r.max_rank >= 14) count[4]++;
        if (r.max_rank >= 13) count[3]++;
        if (r.max_rank >= 12) count[2]++;
        if (r.max_rank >= 11) count[1]++;
        if (r.max_rank >= 10) count[0]++;
        if (r.max_rank < 16) hist[r.max_rank]++;
        if (games > 1 && (g + 1) % 100 == 0) {
            printf("  %d games done\n", g + 1);
        }
    }
    std::chrono::steady_clock::time_point t1 = std::chrono::steady_clock::now();
    double secs = std::chrono::duration<double>(t1 - t0).count();
    printf("games=%d seed=%llu budget=%lld\n", games, seed, budget);
    printf("  >=1024 : %5.1f%%\n", 100.0 * count[0] / games);
    printf("  >=2048 : %5.1f%%\n", 100.0 * count[1] / games);
    printf("  >=4096 : %5.1f%%\n", 100.0 * count[2] / games);
    printf("  >=8192 : %5.1f%%\n", 100.0 * count[3] / games);
    printf("  >=16384: %5.1f%%\n", 100.0 * count[4] / games);
    printf("  >=32768: %5.1f%%\n", 100.0 * count[5] / games);
    printf("  avg score=%lld avg moves=%lld games/s=%.1f\n",
           total_score / games, total_moves / games, games / secs);
    printf("  max-rank histogram (rank=log2(tile)):\n  ");
    for (int k = 0; k < 16; ++k) {
        if (hist[k]) printf("%d:%d  ", k, hist[k]);
    }
    printf("\n");
    return 0;
}

static board_t read_board() {
    board_t board = 0;
    for (int i = 0; i < 16; ++i) {
        long long v;
        if (scanf("%lld", &v) != 1) break;
        int rank = 0;
        if (v > 0) {
            rank = 0;
            long long t = v;
            while (t > 1) {
                t >>= 1;
                rank++;
            }
            if ((1LL << rank) != v) rank = 0; // not a power of two -> treat as 0
        }
        board |= (board_t)(rank & 0xf) << (4 * i);
    }
    return board;
}

static void print_board(board_t board) {
    for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
            int rank = (int)((board >> (4 * (4 * y + x))) & 0xf);
            printf("%d ", rank ? (1 << rank) : 0);
        }
        printf("\n");
    }
}

int main(int argc, char** argv) {
    init_tables();
    std::string mode = argc > 1 ? argv[1] : "bench";
    if (mode == "selftest") {
        return selftest();
    }
    if (mode == "move") {
        long long budget = 0;
        for (int i = 2; i < argc; ++i) {
            if (strcmp(argv[i], "--budget") == 0) budget = parse_budget(argc, argv, i);
        }
        board_t board = read_board();
        int move = find_best_move(board, budget);
        printf("%d\n", move);
        return 0;
    }
    // default: bench
    int games = 100;
    unsigned long long seed = 0;
    long long budget = 0;
    for (int i = 2; i < argc; ++i) {
        if (strcmp(argv[i], "--games") == 0 && i + 1 < argc) games = atoi(argv[++i]);
        else if (strcmp(argv[i], "--seed") == 0 && i + 1 < argc) seed = strtoull(argv[++i], NULL, 10);
        else if (strcmp(argv[i], "--budget") == 0) budget = parse_budget(argc, argv, i);
    }
    return run_bench(games, seed, budget);
}
