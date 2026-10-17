// Pick model (from worker.info.models) and thinking level.
import { Text, View } from 'react-native';
import { THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from '@nopear/protocol';
import { Row, Section, Sheet, usePalette } from '../theme';

export function ModelPicker(props: {
  visible: boolean; models: ModelInfo[]; model: string; thinking: ThinkingLevel; onClose: () => void;
  onChange: (v: { model: string; thinking: ThinkingLevel }) => void;
}) {
  const c = usePalette();
  const check = <Text style={{ color: c.tint, fontSize: 17 }}>✓</Text>;
  const models = props.models.some((m) => m.id === props.model) || !props.model
    ? props.models : [{ id: props.model, name: props.model, reasoning: true }, ...props.models];
  return (
    <Sheet visible={props.visible} title="模型与思考" onClose={props.onClose}>
      <Section title="模型">
        {models.length === 0 ? <Row title="（该机器未报告可用模型）" last /> : null}
        {models.map((m, i) => (
          <Row key={m.id} title={m.name} subtitle={m.id} last={i === models.length - 1}
            right={m.id === props.model ? check : undefined}
            onPress={() => props.onChange({ model: m.id, thinking: props.thinking })} />
        ))}
      </Section>
      <Section title="思考强度" footer="修改在下一轮生效">
        {THINKING_LEVELS.map((t, i) => (
          <Row key={t} title={t} last={i === THINKING_LEVELS.length - 1}
            right={t === props.thinking ? check : undefined}
            onPress={() => props.onChange({ model: props.model, thinking: t })} />
        ))}
      </Section>
      <View style={{ height: 20 }} />
    </Sheet>
  );
}
