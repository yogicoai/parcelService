import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /*
   * 루트를 명시하지 않으면 로컬에서 Next 가 상위로 올라가며 lockfile 을 찾다가
   * 홈 디렉토리(C:\Users\Yogibo Design)를 프로젝트 루트로 잡으려 한다.
   * Vercel 에서는 영향이 없지만 로컬 개발을 위해 둔다.
   *
   * 참고: 업로드 크기는 여기서 늘릴 수 없다. Vercel 서버리스 함수는 요청 본문을
   * 4.5MB 로 강제 제한하고, 그건 설정으로 못 바꾼다. 물류팀 파일은 35일 누적이
   * 0.5MB 수준이라 여유가 충분하다(업로드 화면이 4MB 넘으면 미리 막는다).
   */
  turbopack: { root: __dirname },
};

export default nextConfig;
