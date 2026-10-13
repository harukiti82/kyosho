#!/bin/zsh
# tako:run 撮影した 1 局（src/parts/play.webm）から見せ場の区間（src/parts/segments.txt）をつなぎ、mp4 と GIF を作る
# 先に web/ で npm run promo を流しておく。使うのは ffmpeg だけ（brew install ffmpeg）
set -eu
cd "$(dirname "$0")"
src=src/parts/play.webm
segs=src/parts/segments.txt
mkdir -p video

# 区間ごとに trim して concat する filter を組む（segments.txt は 1 行に「開始 終了」の秒）
filter=""
labels=""
i=0
while read -r a b; do
  filter+="[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}];"
  labels+="[v${i}]"
  i=$((i + 1))
done < "$segs"
filter+="${labels}concat=n=${i}:v=1:a=0[cat]"

# mp4: 録画と同じ 1440×960・30fps・H.264（X・YouTube にそのまま上げられる形。音は録れないので無音）
ffmpeg -y -loglevel error -i "$src" -filter_complex "${filter};[cat]fps=30,format=yuv420p[out]" \
  -map "[out]" -c:v libx264 -preset slow -crf 24 -movflags +faststart -an video/kyosho-play.mp4

# GIF: 始まりの区間（メニュー → カード）の後の 10 秒（最初の数手）を 640 幅・12fps で。パレットを作ってから描く
gif_from=$(head -1 "$segs" | awk '{ s = $2 - $1 - 0.5; print (s > 0 ? s : 0) }')
ffmpeg -y -loglevel error -ss "$gif_from" -t 10 -i video/kyosho-play.mp4 \
  -vf "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  video/kyosho-play.gif

ls -lh video/
ffprobe -v error -show_entries format=duration -of default=nw=1 video/kyosho-play.mp4
