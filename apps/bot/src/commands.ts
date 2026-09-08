import { SlashCommandBuilder } from 'discord.js';
export const commands = [
  new SlashCommandBuilder()
    .setName('회의')
    .setDescription('팀 회의 기록과 열람을 관리합니다')
    .addSubcommand((s) => s.setName('설정').setDescription('현재 회의 기록 설정을 확인합니다'))
    .addSubcommand((s) => s.setName('시작').setDescription('현재 음성방의 회의 기록을 시작합니다'))
    .addSubcommand((s) => s.setName('상태').setDescription('현재 기록 상태와 웹 링크'))
    .addSubcommand((s) => s.setName('종료').setDescription('수집을 종료하고 회의록을 만듭니다'))
    .addSubcommand((s) =>
      s.setName('일시정지').setDescription('새 음성 수집과 전송을 일시정지합니다'),
    )
    .addSubcommand((s) =>
      s.setName('재개').setDescription('기록 재개를 고지하고 음성을 수집합니다'),
    )
    .addSubcommand((s) =>
      s
        .setName('표시')
        .setDescription('현재 시각을 중요 지점으로 표시합니다')
        .addStringOption((o) =>
          o.setName('메모').setDescription('중요 지점 메모').setMaxLength(300),
        ),
    )
    .addSubcommand((s) => s.setName('목록').setDescription('접근 가능한 회의 목록을 엽니다'))
    .addSubcommand((s) =>
      s
        .setName('보기')
        .setDescription('회의 기록을 엽니다')
        .addStringOption((o) => o.setName('회의').setDescription('회의 링크 또는 ID')),
    )
    .addSubcommand((s) =>
      s
        .setName('용어')
        .setDescription('관리자: 프로젝트 발음과 표준 표기 등록')
        .addStringOption((o) =>
          o
            .setName('발음')
            .setDescription('한글 발음, 최대 20자')
            .setRequired(true)
            .setMaxLength(20),
        )
        .addStringOption((o) =>
          o
            .setName('표기')
            .setDescription('전사에 표시할 정확한 표기')
            .setRequired(true)
            .setMaxLength(100),
        )
        .addIntegerOption((o) =>
          o.setName('가중치').setDescription('-5~5, 기본 2').setMinValue(-5).setMaxValue(5),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('재요약')
        .setDescription('종료된 회의의 최신 전사로 요약합니다')
        .addStringOption((o) =>
          o.setName('회의').setDescription('회의 링크 또는 ID').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('정정')
        .setDescription('근거 발언 링크의 전사를 정정합니다')
        .addStringOption((o) =>
          o.setName('발언링크').setDescription('웹에서 복사한 근거 발언 링크').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('내용').setDescription('정정된 발언 전체').setRequired(true).setMaxLength(2000),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('삭제')
        .setDescription('관리자: 삭제 범위를 확인한 후 회의를 삭제합니다')
        .addStringOption((o) =>
          o.setName('회의').setDescription('회의 링크 또는 ID').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('재전사')
        .setDescription('진행자: 저장된 원음의 지정 범위를 다시 전사합니다')
        .addStringOption((o) =>
          o.setName('회의').setDescription('회의 링크 또는 ID').setRequired(true),
        )
        .addUserOption((o) => o.setName('화자').setDescription('재전사할 화자').setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName('시작초')
            .setDescription('회의 시작 기준 시작 초')
            .setRequired(true)
            .setMinValue(0),
        )
        .addIntegerOption((o) =>
          o
            .setName('종료초')
            .setDescription('회의 시작 기준 종료 초')
            .setRequired(true)
            .setMinValue(1),
        ),
    ),
].map((c) => c.toJSON());
