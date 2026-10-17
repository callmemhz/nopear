// Global memory (SaaS, scope "global"): injected into every project-tagged session's system prompt.
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { MemoryEditor } from '../src/components/MemoryEditor';
import { TopBar } from '../src/components/TopBar';
import { usePalette } from '../src/theme';

export default function CollabMemory() {
  const c = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: c.grouped }}>
      <TopBar title="全局记忆" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, padding: 16, paddingBottom: 30, gap: 8 }}>
        <Text style={{ color: c.sub, fontSize: 13 }}>账号级的一份记忆，注入到所有带项目标签的会话。项目记忆在各项目页编辑。</Text>
        <MemoryEditor scope="global" projectId={null} />
      </KeyboardAvoidingView>
    </View>
  );
}
