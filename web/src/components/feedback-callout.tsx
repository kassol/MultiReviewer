import { CheckCircledIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout } from "@radix-ui/themes";

/** 一次写动作的回执:成功一句绿的,失败一句红的(服务端回绝的原话)。 */
export type Feedback = { text: string; error: boolean };

/** 回执那一条 Callout。产品页、会话页与访问控制页同一份;`null` 即此刻没有回执,不画。 */
export function FeedbackCallout({ feedback }: { feedback: Feedback | null }) {
  if (feedback === null) return null;
  return (
    <Callout.Root
      role={feedback.error ? "alert" : "status"}
      color={feedback.error ? "red" : "green"}
      size="1"
    >
      <Callout.Icon>
        {feedback.error ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
      </Callout.Icon>
      <Callout.Text>{feedback.text}</Callout.Text>
    </Callout.Root>
  );
}
