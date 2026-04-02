/**
 * Stopword lists for English and Korean.
 * Used by YAKE keyword extractor to filter out non-discriminative terms.
 */

export const ENGLISH_STOPWORDS = new Set([
  // Articles & determiners
  "a", "an", "the", "this", "that", "these", "those",
  // Pronouns
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "whose",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "about", "against", "along", "among", "around",
  // Conjunctions
  "and", "but", "or", "nor", "so", "yet", "both", "either", "neither",
  // Auxiliary/modal verbs
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing",
  "will", "would", "shall", "should", "may", "might", "must", "can", "could",
  // Common verbs
  "get", "got", "make", "made", "go", "went", "gone", "come", "came",
  "take", "took", "taken", "give", "gave", "given", "say", "said",
  "know", "knew", "known", "think", "thought", "see", "saw", "seen",
  "want", "use", "used", "find", "found", "tell", "told",
  // Adverbs & misc
  "not", "no", "yes", "very", "also", "just", "only", "even", "still",
  "too", "well", "here", "there", "then", "now", "when", "where", "how",
  "why", "all", "each", "every", "any", "some", "few", "more", "most",
  "other", "such", "than", "like", "much", "many", "own",
  // Filler
  "really", "actually", "basically", "probably", "maybe", "definitely",
  "already", "again", "always", "never", "often", "sometimes",
  "thing", "things", "stuff", "something", "anything", "everything", "nothing",
  "way", "lot", "bit", "part", "kind", "type", "time", "day", "year",
  // Tech/chat noise
  "http", "https", "www", "com", "org", "amp", "gt", "lt", "nbsp",
  "lol", "ok", "okay", "yeah", "yep", "nah", "hmm", "etc", "via",
  "re", "fyi", "btw", "imo", "tbh", "idk",
  // Slack-specific
  "thread", "replies", "reply", "channel", "message",
]);

/**
 * Korean particles (조사), endings (어미), and functional morphemes.
 * These are common suffixes/postpositions that should be stripped.
 */
export const KOREAN_PARTICLES = new Set([
  // Subject/topic markers
  "은", "는", "이", "가", "을", "를", "에", "에서", "에게", "으로", "로",
  "와", "과", "의", "도", "만", "까지", "부터", "마저", "조차", "밖에",
  "처럼", "같이", "만큼", "대로", "보다", "한테", "께", "서",
  // Endings
  "다", "고", "며", "면", "지", "니", "요", "죠", "네", "거든",
  "ㄴ", "ㄹ", "ㅂ", "ㅆ", "ㅎ",
  // Common functional words
  "것", "수", "등", "중", "때", "더", "안", "못", "잘", "좀",
  "그", "이", "저", "어떤", "무슨", "아주", "매우", "정말", "너무",
  "하다", "되다", "있다", "없다", "같다", "나다",
  // Pronouns
  "나", "저", "우리", "너", "당신", "그녀", "그들",
]);

export const KOREAN_STOPWORDS = new Set([
  "그리고", "하지만", "그런데", "그래서", "따라서", "그러나", "또한", "또는",
  "때문에", "이런", "저런", "그런", "어떤", "이것", "저것", "그것",
  "여기", "거기", "저기", "지금", "오늘", "내일", "어제",
  "합니다", "입니다", "습니다", "됩니다", "있습니다", "없습니다",
  "하는", "되는", "있는", "없는", "같은", "대한",
  "위해", "통해", "관한", "대해", "의해",
]);
