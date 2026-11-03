export const dandanplayRatingScale = {
  source: 'explicit_user_statement', personal_rating_field: 'bangumis.UserRating',
  labels: { '0': '未评分', '6': '勉强能看下去', '8': '挺好看的', '10': '非常好看' },
  zero_means_unrated: true, other_scores: '保留原值，不推断含义',
} as const;

export const dandanplaySummarySql = `SELECT COUNT(*) AS anime_records,
  SUM(CASE WHEN json_extract(payload,'$.following')=1 THEN 1 ELSE 0 END) AS following,
  SUM(CASE WHEN json_extract(payload,'$.following')=0 THEN 1 ELSE 0 END) AS not_following,
  SUM(CASE WHEN json_extract(payload,'$.following')=1 AND json_extract(payload,'$.completion_state')='not_completed' THEN 1 ELSE 0 END) AS following_not_completed,
  SUM(CASE WHEN json_extract(payload,'$.following')=1 AND json_extract(payload,'$.completion_state')='completed' THEN 1 ELSE 0 END) AS following_completed,
  SUM(CASE WHEN json_extract(payload,'$.following')=1 AND json_extract(payload,'$.completion_state')='abandoned' THEN 1 ELSE 0 END) AS following_abandoned,
  SUM(CASE WHEN json_extract(payload,'$.user_rating')>0 THEN 1 ELSE 0 END) AS rated,
  SUM(CASE WHEN json_extract(payload,'$.user_rating_state')='unrated' THEN 1 ELSE 0 END) AS unrated
  FROM media_records WHERE platform='dandanplay' AND dataset='watchlist'`;

export function dandanplaySummary(row: Record<string, unknown>) {
  const n = (key: string) => Number(row[key] ?? 0);
  return { scope: 'all_synced_watchlist_records', anime_records: n('anime_records'), following: n('following'), not_following: n('not_following'),
    following_completion: { not_completed: n('following_not_completed'), completed: n('following_completed'), abandoned: n('following_abandoned'), unknown: n('following') - n('following_not_completed') - n('following_completed') - n('following_abandoned') },
    personal_ratings: { rated: n('rated'), unrated: n('unrated'), unknown: n('anime_records') - n('rated') - n('unrated') },
  };
}
